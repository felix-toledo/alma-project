import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type AttachFs, attachmentOpenAllowed, Grants, insideAttachmentStore, openableAttachment, touchesAttachmentStore, inspectGranted, inspectPath, pickPaths, readForAttach, readGranted, readUpTo } from '../src/main/attach'
import { ATTACH_LIMITS } from '../src/shared/attach/rules'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alma-attach-main-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const fileStats = (size: number) => ({ size, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false })
const failing = (code: string): AttachFs => ({
  lstat: () => Promise.reject(Object.assign(new Error(code), { code })),
  readdir: () => Promise.reject(new Error('unused')),
  readFile: () => Promise.reject(new Error('unused'))
})

describe('inspectPath (spec 030 T37)', () => {
  it('AC-1.9 (030) inspect lists direct regular files only', async () => {
    writeFileSync(join(dir, 'a.txt'), 'aaa')
    writeFileSync(join(dir, 'b.md'), 'bb')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'deep.txt'), 'never listed')

    const info = await inspectPath(dir)
    expect(info.kind).toBe('folder')
    if (info.kind !== 'folder') return
    expect(info.name).toBe(basename(dir))
    expect([...info.files].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { path: join(dir, 'a.txt'), name: 'a.txt', size: 3 },
      { path: join(dir, 'b.md'), name: 'b.md', size: 2 }
    ])
    expect(info.files.every((f) => isAbsolute(f.path))).toBe(true)
    expect(info.skipped).toBe(1)
  })

  it('AC-1.9 (030) symlinks, junctions and anything not a regular file count as skipped', async () => {
    const entry = (name: string, isFile: boolean) => ({ name, isFile: () => isFile })
    const fake: AttachFs = {
      lstat: (path) =>
        Promise.resolve(
          path.endsWith('swapped.txt')
            ? { size: 1, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }
            : path === 'C:\\drop'
              ? { size: 0, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
              : { size: 7, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }
        ),
      readdir: () => Promise.resolve([entry('real.txt', true), entry('link.txt', false), entry('junction', false), entry('swapped.txt', true)]),
      readFile: () => Promise.reject(new Error('unused'))
    }
    const info = await inspectPath('C:\\drop', fake)
    expect(info).toEqual({ kind: 'folder', name: 'drop', files: [{ path: join('C:\\drop', 'real.txt'), name: 'real.txt', size: 7 }], skipped: 3 })
  })

  it('AC-1.9 (030) a file, an empty folder, a missing path and a link top level', async () => {
    writeFileSync(join(dir, 'a.txt'), 'abcd')
    mkdirSync(join(dir, 'empty'))
    expect(await inspectPath(join(dir, 'a.txt'))).toEqual({ kind: 'file', name: 'a.txt', size: 4 })
    expect(await inspectPath(join(dir, 'empty'))).toEqual({ kind: 'folder', name: 'empty', files: [], skipped: 0 })
    expect(await inspectPath(join(dir, 'gone'))).toEqual({ kind: 'failed', reason: 'missing' })
    const link: AttachFs = {
      lstat: () => Promise.resolve({ size: 0, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }),
      readdir: () => Promise.reject(new Error('must not list through a link')),
      readFile: () => Promise.reject(new Error('unused'))
    }
    expect(await inspectPath('C:\\link', link)).toEqual({ kind: 'failed', reason: 'unreadable' })
  })
})

describe('readUpTo (spec 030 AC-2.4)', () => {
  // a handle that answers like a network or FUSE file: never more than `step` bytes per read, wherever it is asked to read
  const handleOf = (content: Buffer, step: number, kind: 'file' | 'dir' | 'other' = 'file') => ({
    stat: () => Promise.resolve({ size: content.length, isFile: () => kind === 'file', isDirectory: () => kind === 'dir' }),
    read: (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Math.min(step, length, Math.max(content.length - position, 0))
      content.copy(buffer, offset, position, position + bytesRead)
      return Promise.resolve({ bytesRead })
    },
    close: () => Promise.resolve()
  })
  const open = (content: Buffer, step: number, kind?: 'file' | 'dir' | 'other') => () => Promise.resolve(handleOf(content, step, kind) as never)

  it('AC-2.4 (030) short reads are followed to the end of the file, not stored truncated', async () => {
    const content = Buffer.from('x'.repeat(100_000))
    const got = await readUpTo('C:\\net.txt', ATTACH_LIMITS.maxFileBytes + 1, open(content, 4096))
    expect(Buffer.from(got).equals(content)).toBe(true)
  })

  it('AC-2.4 (030) at most the limit is read, and a file that grew past it is seen as over it', async () => {
    const got = await readUpTo('C:\\grow.bin', 1000, open(Buffer.alloc(5000, 1), 300))
    expect(got.length).toBe(1000)
  })

  it('AC-2.4 (030) the handle is checked: a folder or a device is refused, and only the size of the file is allocated', async () => {
    await expect(readUpTo('C:\\d', 100, open(Buffer.alloc(1), 1, 'dir'))).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(readUpTo('C:\\pipe', 100, open(Buffer.alloc(1), 1, 'other'))).rejects.toMatchObject({ code: 'EINVAL' })
    expect(await readUpTo('C:\\empty', 100, open(Buffer.alloc(0), 10))).toHaveLength(0)
  })
})

describe('readForAttach (spec 030 T36)', () => {
  it('AC-2.4 (030) read outcomes carry a reason', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'hello')
    mkdirSync(join(dir, 'sub'))

    const ok = await readForAttach(join(dir, 'notes.txt'))
    expect(ok).toEqual({ ok: true, name: 'notes.txt', size: 5, base64: Buffer.from('hello').toString('base64') })

    expect(await readForAttach(join(dir, 'gone.txt'))).toEqual({ ok: false, reason: 'missing' })
    expect(await readForAttach(join(dir, 'sub'))).toEqual({ ok: false, reason: 'is-folder' })
    expect(await readForAttach(join(dir, 'notes.txt'), failing('EACCES'))).toEqual({ ok: false, reason: 'denied' })
    expect(await readForAttach(join(dir, 'notes.txt'), failing('EPERM'))).toEqual({ ok: false, reason: 'denied' })
    expect(await readForAttach(join(dir, 'notes.txt'), failing('EBUSY'))).toEqual({ ok: false, reason: 'busy' })
    expect(await readForAttach(join(dir, 'notes.txt'), failing('EIO'))).toEqual({ ok: false, reason: 'unreadable' })
  })

  it('AC-2.4 (030) a file over the limit is refused from stat without reading it', async () => {
    let reads = 0
    const huge: AttachFs = {
      lstat: () => Promise.resolve(fileStats(ATTACH_LIMITS.maxFileBytes + 1)),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => {
        reads++
        return Promise.resolve(new Uint8Array(0))
      }
    }
    expect(await readForAttach('C:\\big.pdf', huge)).toEqual({ ok: false, reason: 'too-big' })
    expect(reads).toBe(0)

    // The boundary itself still reads.
    const exact: AttachFs = { ...huge, lstat: () => Promise.resolve(fileStats(ATTACH_LIMITS.maxFileBytes)), readFile: () => Promise.resolve(new Uint8Array(ATTACH_LIMITS.maxFileBytes)) }
    expect((await readForAttach('C:\\edge.pdf', exact)).ok).toBe(true)
  })

  it('AC-2.4 (030) a file that grew past the limit after stat is refused', async () => {
    const grew: AttachFs = {
      lstat: () => Promise.resolve(fileStats(10)),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.resolve(new Uint8Array(ATTACH_LIMITS.maxFileBytes + 1))
    }
    expect(await readForAttach('C:\\grow.txt', grew)).toEqual({ ok: false, reason: 'too-big' })
  })

  it('AC-1.9 (030) a symlink is not followed when read', async () => {
    const link: AttachFs = {
      lstat: () => Promise.resolve({ size: 4, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true }),
      readdir: () => Promise.reject(new Error('unused')),
      readFile: () => Promise.reject(new Error('must not read through a link'))
    }
    expect(await readForAttach('C:\\link.txt', link)).toEqual({ ok: false, reason: 'unreadable' })
  })
})

describe('Grants (spec 030 T38)', () => {
  it('AC-1.8 (030) pick grants only the returned paths', async () => {
    const grants = new Grants()
    const picked = await pickPaths(() => Promise.resolve([join(dir, 'a.txt'), join(dir, 'b.txt')]), grants)
    expect(picked).toEqual([join(dir, 'a.txt'), join(dir, 'b.txt')])
    expect(grants.has(join(dir, 'a.txt'))).toBe(true)
    expect(grants.has(join(dir, 'b.txt'))).toBe(true)
    expect(grants.has(join(dir, 'c.txt'))).toBe(false)
  })

  it('AC-1.8 (030) cancelling the dialog returns no paths and grants nothing', async () => {
    const grants = new Grants()
    expect(await pickPaths(() => Promise.resolve([]), grants)).toEqual([])
    expect(grants.has(join(dir, 'a.txt'))).toBe(false)
  })

  it('AC-1.8 (030) a path that was never granted is denied', async () => {
    writeFileSync(join(dir, 'secret.txt'), 'x')
    const grants = new Grants()
    expect(await readGranted(join(dir, 'secret.txt'), grants)).toEqual({ ok: false, reason: 'denied' })
    expect(await inspectGranted(dir, grants)).toEqual({ kind: 'failed', reason: 'denied' })
    // A relative path is never a grant, whatever the working folder is.
    grants.grant(join(dir, 'secret.txt'))
    expect(await readGranted('secret.txt', grants)).toEqual({ ok: false, reason: 'denied' })
  })

  it('AC-1.8 (030) a grant is consumed by the read', async () => {
    writeFileSync(join(dir, 'a.txt'), 'abc')
    const grants = new Grants()
    grants.grant(join(dir, 'a.txt'))
    expect((await readGranted(join(dir, 'a.txt'), grants)).ok).toBe(true)
    expect(await readGranted(join(dir, 'a.txt'), grants)).toEqual({ ok: false, reason: 'denied' })
  })

  it('AC-1.8 (030) inspect does not consume the grant, so the same path can be read after it', async () => {
    writeFileSync(join(dir, 'a.txt'), 'abc')
    const grants = new Grants()
    grants.grant(join(dir, 'a.txt'))
    expect(await inspectGranted(join(dir, 'a.txt'), grants)).toEqual({ kind: 'file', name: 'a.txt', size: 3 })
    expect((await readGranted(join(dir, 'a.txt'), grants)).ok).toBe(true)
  })

  it('AC-1.8 (030) inspecting a granted folder grants its listed files and nothing else', async () => {
    writeFileSync(join(dir, 'a.txt'), 'abc')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'deep.txt'), 'x')
    const grants = new Grants()
    grants.grant(dir)
    const info = await inspectGranted(dir, grants)
    expect(info.kind).toBe('folder')
    expect((await readGranted(join(dir, 'sub', 'deep.txt'), grants)).ok).toBe(false)
    expect((await readGranted(join(dir, 'a.txt'), grants)).ok).toBe(true)
  })

  it('AC-1.8 (030) grants expire', async () => {
    let now = 1_000
    const grants = new Grants(() => now, 60_000)
    grants.grant(join(dir, 'a.txt'))
    now += 59_999
    expect(grants.has(join(dir, 'a.txt'))).toBe(true)
    now += 2
    expect(grants.has(join(dir, 'a.txt'))).toBe(false)
    expect(grants.consume(join(dir, 'a.txt'))).toBe(false)
  })

  it('AC-1.8 (030) the same path in another spelling is the same grant, and the set is bounded', () => {
    const grants = new Grants(() => 0, 60_000, 3)
    grants.grant('C:\\Docs\\A.txt')
    expect(grants.has('c:/docs/./a.txt')).toBe(true)
    for (const n of [1, 2, 3]) grants.grant(`C:\\Docs\\f${n}.txt`)
    expect(grants.has('C:\\Docs\\A.txt')).toBe(false)
    expect(grants.has('C:\\Docs\\f3.txt')).toBe(true)
  })
})

describe('open guard (spec 030 T39)', () => {
  const root = join(tmpdir(), 'alma-user', 'inbox', 'attachments')
  const id = '0b5c1c9e-2f4a-4d3e-9a6b-1c2d3e4f5a6b'

  it('AC-7.5 (030) the open guard accepts a listed file inside the store only', () => {
    expect(attachmentOpenAllowed(join(root, id, 'report.pdf'), root)).toBe(true)
    expect(attachmentOpenAllowed(join(root, id, 'photo.png'), root)).toBe(true)
    expect(attachmentOpenAllowed(join(root, id, 'REPORT.PDF'), root)).toBe(true)
    expect(attachmentOpenAllowed(join(root, id, 'Sheet.XlSx'), root)).toBe(true)
  })

  it('AC-7.5 (030) the open guard refuses anything else', () => {
    const refused = [
      join(root, id, 'tool.exe'),
      join(root, id, 'main.ts'),
      join(root, id, 'macro.xlsm'),
      join(root, id, 'page.html'),
      join(root, id, 'README'),
      join(root, id, 'report.pdf.'),
      join(root, id, 'report.pdf:stream'),
      join(root, id, '..', '..', 'x.pdf'),
      join(root, '..', 'x.pdf'),
      `${root}-evil${sep}${id}${sep}x.pdf`,
      join(tmpdir(), 'elsewhere', 'x.pdf'),
      root,
      join(root, 'report.pdf'),
      'report.pdf',
      `${root}${sep}..${sep}..${sep}x.pdf`
    ]
    for (const path of refused) expect(attachmentOpenAllowed(path, root), path).toBe(false)
    expect(attachmentOpenAllowed(undefined as unknown as string, root)).toBe(false)
  })

  it('AC-7.5 (030) the openPath refusal covers every path inside the store and none outside', () => {
    expect(insideAttachmentStore(join(root, id, 'tool.exe'), root)).toBe(true)
    expect(insideAttachmentStore(join(root, `${id}.json`), root)).toBe(true)
    expect(insideAttachmentStore(root, root)).toBe(true)
    expect(insideAttachmentStore(join(root, id, '..', '..', 'x.txt'), root)).toBe(false)
    expect(insideAttachmentStore(`${root}-evil${sep}x.txt`, root)).toBe(false)
    expect(insideAttachmentStore(join(tmpdir(), 'x.txt'), root)).toBe(false)
    expect(insideAttachmentStore('relative.txt', root)).toBe(false)
  })
})

describe('openableAttachment (spec 030 T41)', () => {
  it('AC-7.5 (030) the host handler opens an existing listed file of the store and follows no link out of it', () => {
    const root = join(dir, 'inbox', 'attachments')
    const id = '0b5c1c9e-2f4a-4d3e-9a6b-1c2d3e4f5a6b'
    mkdirSync(join(root, id), { recursive: true })
    writeFileSync(join(root, id, 'report.pdf'), '%PDF-')
    writeFileSync(join(root, id, 'tool.exe'), 'MZ')
    expect(openableAttachment(join(root, id, 'report.pdf'), root)).toBe(realpathSync.native(join(root, id, 'report.pdf')))
    expect(openableAttachment(join(root, id, 'tool.exe'), root)).toBeNull()
    expect(openableAttachment(join(root, id, 'gone.pdf'), root)).toBeNull()

    // A junction placed in the store that leads out of it: the path looks inside, the real file is not.
    const outside = join(dir, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.pdf'), '%PDF-')
    symlinkSync(outside, join(root, 'e0b5c1c9-2f4a-4d3e-9a6b-1c2d3e4f5a6b'), 'junction')
    expect(openableAttachment(join(root, 'e0b5c1c9-2f4a-4d3e-9a6b-1c2d3e4f5a6b', 'secret.pdf'), root)).toBeNull()

    // The refusal of shell:openPath also sees through a junction that leads into the store.
    symlinkSync(root, join(dir, 'shortcut'), 'junction')
    expect(touchesAttachmentStore(join(dir, 'shortcut', id, 'tool.exe'), root)).toBe(true)
    expect(touchesAttachmentStore(join(root, id, 'tool.exe'), root)).toBe(true)
    expect(touchesAttachmentStore(join(outside, 'secret.pdf'), root)).toBe(false)
    expect(touchesAttachmentStore(join(dir, 'not-there.txt'), join(dir, 'no-store-yet'))).toBe(false)
  })
})
