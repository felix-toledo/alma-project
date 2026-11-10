import { describe, expect, it } from 'vitest'
import { intakeFiles, type IntakeDeps, type IntakeSource } from '../src/shared/attach/intake'
import { ATTACH_LIMITS } from '../src/shared/attach/rules'
import type { PathInfo, PathRead } from '../src/shared/desktop-api'
import type { StoreResult } from '../src/shared/types'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]
const MZ = [...Buffer.from('MZ'), 0x90, 0x00, 0x03]
const b64 = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString('base64')
const bytesOf = (s: string) => [...Buffer.from(s)]

type Disk = Record<string, { bytes: number[] } | { folder: { name: string; files: string[]; skipped: number } } | { fail: 'missing' | 'denied' | 'busy' | 'unreadable' | 'is-folder' } | { throws: true }>

function rig(disk: Disk, over: Partial<IntakeDeps> = {}) {
  const log = { read: [] as string[], stored: [] as { name: string; size: number }[], asked: [] as string[] }
  const base = (p: string) => p.split(/[\\/]/).pop() ?? p
  const deps: IntakeDeps = {
    canAttach: true,
    existing: [],
    now: () => 1_700_000_000_000,
    async inspect(path): Promise<PathInfo> {
      const e = disk[path]
      if (!e) return { kind: 'failed', reason: 'missing' }
      if ('throws' in e) return { kind: 'file', name: base(path), size: 1 }
      if ('fail' in e) return { kind: 'failed', reason: e.fail }
      if ('folder' in e) {
        return { kind: 'folder', name: e.folder.name, skipped: e.folder.skipped, files: e.folder.files.map((p) => ({ path: p, name: base(p), size: ('bytes' in disk[p] ? (disk[p] as { bytes: number[] }).bytes.length : 0) })) }
      }
      return { kind: 'file', name: base(path), size: e.bytes.length }
    },
    async read(path): Promise<PathRead> {
      log.read.push(path)
      const e = disk[path]
      if (!e) return { ok: false, reason: 'missing' }
      if ('throws' in e) throw new Error('ipc down')
      if ('fail' in e) return { ok: false, reason: e.fail }
      if ('folder' in e) return { ok: false, reason: 'is-folder' }
      return { ok: true, name: base(path), size: e.bytes.length, base64: b64(e.bytes) }
    },
    async store(file): Promise<StoreResult> {
      log.stored.push({ name: file.name, size: file.size })
      return { ok: true, attachment: { id: `id-${log.stored.length}`, name: file.name, kind: file.name.endsWith('.png') ? 'image' : 'text', size: file.size } }
    },
    async confirmSecret(name) {
      log.asked.push(name)
      return true
    },
    ...over,
  }
  return { deps, log }
}

const paths = (...p: string[]): IntakeSource[] => p.map((path) => ({ name: path.split(/[\\/]/).pop() ?? path, path }))

describe('chat attachment intake', () => {
  it('AC-1.4 (030) each file is checked on its own and refused ones do not drop accepted ones', async () => {
    const { deps, log } = rig({
      'C:\\d\\ok.txt': { bytes: bytesOf('hello') },
      'C:\\d\\bad.exe': { bytes: MZ },
      'C:\\d\\fake.png': { bytes: MZ },
      'C:\\d\\pic.png': { bytes: PNG },
      'C:\\d\\gone.txt': { fail: 'missing' },
    })
    const r = await intakeFiles(paths('C:\\d\\ok.txt', 'C:\\d\\bad.exe', 'C:\\d\\fake.png', 'C:\\d\\pic.png', 'C:\\d\\gone.txt'), deps)
    expect(r.added.map((a) => a.name)).toEqual(['ok.txt', 'pic.png'])
    expect(r.refused).toEqual([
      { name: 'bad.exe', reason: 'type' },
      { name: 'fake.png', reason: 'content' },
      { name: 'gone.txt', reason: 'missing' },
    ])
    // nothing refused reaches the store
    expect(log.stored.map((s) => s.name)).toEqual(['ok.txt', 'pic.png'])
  })

  it('AC-1.7 (030) any dropped type goes through classify and a refusal always names the file', async () => {
    const { deps } = rig({ 'C:\\d\\a.zip': { bytes: [0x50, 0x4b, 3, 4] }, 'C:\\d\\noext': { bytes: bytesOf('x') }, 'C:\\d\\empty.txt': { bytes: [] } })
    const r = await intakeFiles(paths('C:\\d\\a.zip', 'C:\\d\\noext', 'C:\\d\\empty.txt'), deps)
    expect(r.added).toEqual([])
    expect(r.refused).toEqual([
      { name: 'a.zip', reason: 'type' },
      { name: 'noext', reason: 'type' },
      { name: 'empty.txt', reason: 'empty' },
    ])
  })

  it('AC-2.2 (030) a file over the size limit is refused and nothing is stored', async () => {
    const big = new Array(ATTACH_LIMITS.maxFileBytes + 1).fill(97)
    const { deps, log } = rig({ 'C:\\d\\big.txt': { bytes: big } })
    const r = await intakeFiles(paths('C:\\d\\big.txt'), deps)
    expect(r.refused).toEqual([{ name: 'big.txt', reason: 'too-big' }])
    expect(log.stored).toEqual([])
  })

  it('AC-2.3 (030) chips already present count and a refused file uses no budget', async () => {
    const disk: Disk = {}
    const list: string[] = []
    for (let i = 1; i <= 4; i++) {
      disk[`C:\\d\\f${i}.txt`] = { bytes: bytesOf(String(i)) }
      list.push(`C:\\d\\f${i}.txt`)
    }
    disk['C:\\d\\bad.exe'] = { bytes: MZ }
    const { deps } = rig(disk, { existing: [{ size: 1 }, { size: 1 }, { size: 1 }] })
    const r = await intakeFiles(paths('C:\\d\\bad.exe', ...list), deps)
    // three chips + two more fit; the bad one used nothing; the 3rd and 4th new files are over the count
    expect(r.added.map((a) => a.name)).toEqual(['f1.txt', 'f2.txt'])
    expect(r.refused).toEqual([
      { name: 'bad.exe', reason: 'type' },
      { name: 'f3.txt', reason: 'too-many' },
      { name: 'f4.txt', reason: 'too-many' },
    ])
  })

  it('AC-2.3 (030) the total of a message is limited too', async () => {
    const { deps } = rig({ 'C:\\d\\a.txt': { bytes: bytesOf('abc') } }, { existing: [{ size: ATTACH_LIMITS.maxTotalBytes - 2 }] })
    const r = await intakeFiles(paths('C:\\d\\a.txt'), deps)
    expect(r.refused).toEqual([{ name: 'a.txt', reason: 'total' }])
  })

  it('AC-2.4 (030) a file that cannot be read is refused with the reason and a throwing bridge is unreadable', async () => {
    const { deps, log } = rig({ 'C:\\d\\a.txt': { fail: 'denied' }, 'C:\\d\\b.txt': { fail: 'busy' }, 'C:\\d\\c.txt': { throws: true } })
    const r = await intakeFiles(paths('C:\\d\\a.txt', 'C:\\d\\b.txt', 'C:\\d\\c.txt'), deps)
    expect(r.refused).toEqual([
      { name: 'a.txt', reason: 'denied' },
      { name: 'b.txt', reason: 'busy' },
      { name: 'c.txt', reason: 'unreadable' },
    ])
    expect(log.stored).toEqual([])
  })

  it('AC-2.5 (030) a failing store gives no chip and says why', async () => {
    const { deps } = rig(
      { 'C:\\d\\a.txt': { bytes: bytesOf('a') }, 'C:\\d\\b.txt': { bytes: bytesOf('b') } },
      {
        async store(file) {
          if (file.name === 'a.txt') return { ok: false, reason: 'storage' }
          throw new Error('coordinator down')
        },
      },
    )
    const r = await intakeFiles(paths('C:\\d\\a.txt', 'C:\\d\\b.txt'), deps)
    expect(r.added).toEqual([])
    expect(r.refused).toEqual([
      { name: 'a.txt', reason: 'storage' },
      { name: 'b.txt', reason: 'storage' },
    ])
  })

  it('AC-1.5 (030) a pasted picture without a name gets the default name and never touches the disk bridge', async () => {
    const { deps, log } = rig({})
    const blob: IntakeSource = { name: 'image.png', size: PNG.length, base64: async () => b64(PNG) }
    const r = await intakeFiles([blob, { name: 'shot.png', size: PNG.length, base64: async () => b64(PNG) }], deps)
    expect(r.added.map((a) => a.name)).toEqual(['imagen-1700000000000.png', 'shot.png'])
    expect(log.read).toEqual([])
  })

  it('AC-1.6 (030) a pasted blob is classified on its bytes like a file', async () => {
    const { deps } = rig({})
    const r = await intakeFiles([{ name: 'fake.png', size: MZ.length, base64: async () => b64(MZ) }], deps)
    expect(r.refused).toEqual([{ name: 'fake.png', reason: 'content' }])
  })

  it('AC-1.9 (030) a folder adds its direct files and reports the skipped subfolders', async () => {
    const { deps } = rig({
      'C:\\f': { folder: { name: 'f', files: ['C:\\f\\a.txt', 'C:\\f\\b.exe'], skipped: 2 } },
      'C:\\f\\a.txt': { bytes: bytesOf('a') },
      'C:\\f\\b.exe': { bytes: MZ },
    })
    const r = await intakeFiles(paths('C:\\f'), deps)
    expect(r.added.map((a) => a.name)).toEqual(['a.txt'])
    expect(r.refused).toEqual([{ name: 'b.exe', reason: 'type' }])
    expect(r.skippedFolders).toEqual([{ folder: 'f', count: 2 }])
  })

  it('AC-1.9 (030) a folder over the count is refused whole and nothing is read or stored', async () => {
    const disk: Disk = {}
    const files = [1, 2, 3, 4, 5, 6].map((i) => `C:\\f\\${i}.txt`)
    for (const f of files) disk[f] = { bytes: bytesOf('x') }
    disk['C:\\f'] = { folder: { name: 'f', files, skipped: 1 } }
    const { deps, log } = rig(disk)
    const r = await intakeFiles(paths('C:\\f'), deps)
    expect(r.added).toEqual([])
    expect(r.refused).toEqual([{ name: 'f', reason: 'too-many', folder: true }])
    expect(r.skippedFolders).toEqual([{ folder: 'f', count: 1 }])
    expect(log.read).toEqual([])
    expect(log.stored).toEqual([])
  })

  it('AC-1.9 (030) a folder with no files is reported, not ignored', async () => {
    const { deps } = rig({ 'C:\\f': { folder: { name: 'f', files: [], skipped: 0 } } })
    const r = await intakeFiles(paths('C:\\f'), deps)
    expect(r.refused).toEqual([{ name: 'f', reason: 'empty', folder: true }])
  })

  it('AC-1.11 (030) a company conversation refuses every source before reading', async () => {
    const { deps, log } = rig({ 'C:\\d\\a.txt': { bytes: bytesOf('a') } }, { canAttach: false })
    const r = await intakeFiles([...paths('C:\\d\\a.txt'), { name: 'image.png', size: 3, base64: async () => b64(PNG) }], deps)
    expect(r.added).toEqual([])
    expect(r.refused).toEqual([
      { name: 'a.txt', reason: 'company' },
      { name: 'image.png', reason: 'company' },
    ])
    expect(log.read).toEqual([])
    expect(log.stored).toEqual([])
  })

  it('AC-3.2 (030) a secret-looking name or path asks first; cancelling stores nothing and makes no chip', async () => {
    const asked: string[] = []
    const { deps, log } = rig(
      { 'C:\\proj\\.env\\notes.txt': { bytes: bytesOf('n') }, 'C:\\d\\passwords.csv': { bytes: bytesOf('p') }, 'C:\\d\\plain.txt': { bytes: bytesOf('x') } },
      { confirmSecret: async (name) => (asked.push(name), false) },
    )
    const r = await intakeFiles(paths('C:\\proj\\.env\\notes.txt', 'C:\\d\\passwords.csv', 'C:\\d\\plain.txt'), deps)
    // the path counted for notes.txt; the plain file was never asked about; a declined file is no refusal
    expect(asked).toEqual(['notes.txt', 'passwords.csv'])
    expect(r.added.map((a) => a.name)).toEqual(['plain.txt'])
    expect(r.refused).toEqual([])
    expect(log.stored.map((s) => s.name)).toEqual(['plain.txt'])
  })

  it('AC-3.2 (030) confirming attaches a secret-looking file as usual', async () => {
    const { deps, log } = rig({ 'C:\\keys\\credentials.json': { bytes: bytesOf('{}') } })
    const r = await intakeFiles(paths('C:\\keys\\credentials.json'), deps)
    expect(log.asked).toEqual(['credentials.json'])
    expect(r.added.map((a) => a.name)).toEqual(['credentials.json'])
  })

  it('AC-3.2 (030) a refused file is never warned about', async () => {
    const { deps, log } = rig({ 'C:\\keys\\server.pem': { bytes: bytesOf('x') } })
    const r = await intakeFiles(paths('C:\\keys\\server.pem'), deps)
    expect(r.refused).toEqual([{ name: 'server.pem', reason: 'type' }])
    expect(log.asked).toEqual([])
  })
})
