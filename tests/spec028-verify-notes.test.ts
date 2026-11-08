import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KnowledgeBase } from '../src/coordinator/knowledge/base'
import { NotesFlow } from '../src/coordinator/channels/remote/notes'
import { defaultSettings } from '../src/shared/defaults'
import { defaultRemote } from '../src/shared/remote/settings'
import { canonicalVaultPath, findByName, isExcluded, isReachable, moveExclusions, staleExclusions, toggleExclusion } from '../src/shared/vault/paths'
import { testChannel, type Harness } from './support/remote-harness'

// Adversarial verification of spec 028 §Notes, written without reading the plan or the implementer's notes.

const MB = 1_048_576
const unavailable = { status: 404, headers: { 'cache-control': 'no-store' }, body: { error: 'unavailable' } }

async function served(options: { excluded?: string[]; scopes?: Partial<ReturnType<typeof defaultRemote>['scopes']>; record?: (e: never) => void } = {}): Promise<Harness> {
  const remote = { ...defaultRemote(), enabled: true, scopes: { ...defaultRemote().scopes, vault: true, ...options.scopes }, vaultExcluded: options.excluded ?? [] }
  const t = await testChannel({ remote })
  await t.channel.sync()
  return t
}

describe('AC-2.4 / AC-1.9 / AC-7.4 (028 verify) hostile paths all get the one unavailable answer', () => {
  it('AC-2.4 (028 verify) encodings, streams, trailing dot or space, drive letters, UNC, NUL, control chars and case never reach a disk read or leak', async () => {
    const t = await served({ excluded: ['Privado'] })
    t.vault.put('Notas/ok.md', 'visible')
    t.vault.put('Privado/a.md', 'secreto')
    const hostile = [
      '%2e%2e/Privado/a.md',
      '%2E%2E%2FPrivado%2Fa.md',
      '..%5CPrivado%5Ca.md',
      'Notas/ok.md.',
      'Notas/ok.md ',
      'Notas/ok.md::$DATA',
      'Notas/ok.md:stream',
      'Notas/ok.md:stream:$DATA',
      'Notas:/ok.md',
      'C:Notas/ok.md',
      'C:/Notas/ok.md',
      '\\\\srv\\share\\Notas\\ok.md',
      '//srv/share/Notas/ok.md',
      '\\Notas\\ok.md',
      '/Notas/ok.md',
      'Notas/ok.md\u0000',
      'Notas/\u0001ok.md',
      'Notas/ok.md\r\n',
      'Notas/./ok.md',
      'Notas/../Notas/ok.md',
      './Notas/ok.md',
      'Privado./a.md',
      'Privado /a.md',
      'Privado::$INDEX_ALLOCATION/a.md',
      'PRIVADO/A.MD',
      'privado\\a.md',
      'Privado//a.md',
      'Privado/a.md/',
      'Privado/a.md/.',
      'PRIVAD~1/a.md',
      'NOTAS~1/OK~1.MD',
      'node_modules/x.md',
      'Notas/NODE_MODULES/x.md',
      '.git/config',
      'Notas/.hidden/x.md',
      '.'
    ]
    const before = { ...t.vault.reads }
    for (const path of hostile) {
      const res = await t.call('/api/notes/read', { path })
      expect(res, JSON.stringify(path)).toEqual(unavailable)
    }
    // Not one of them asked the vault to open anything.
    expect(t.vault.reads.readText).toBe(before.readText)
    expect(t.vault.reads.readBytes).toBe(before.readBytes)
    // The same strings as a listing never list the excluded folder's content.
    for (const folder of ['Privado', 'PRIVADO', 'privado\\', '/Privado', 'Privado/.', 'Privado./', '%2e%2e/Privado', '..']) {
      const res = await t.call('/api/notes/list', { folder })
      expect(JSON.stringify(res.body), folder).not.toContain('a.md')
    }
  })

  it('AC-2.4 (028 verify) byte-identical answers for missing, hidden, excluded and a big excluded note, on read and on image', async () => {
    const t = await served({ excluded: ['Privado'] })
    t.vault.put('Privado/grande.md', 'x'.repeat(6 * MB))
    t.vault.put('Privado/p.png', new Uint8Array(3 * MB))
    t.vault.put('Privado/doc.pdf', 'pdf')
    t.vault.put('.oculto/n.md', 'oculto', { listed: false })
    const reads = ['no/existe.md', 'Privado/grande.md', 'Privado/doc.pdf', '.oculto/n.md', 'Privado/no-existe.md', 'privado/GRANDE.md']
    const first = await t.call('/api/notes/read', { path: reads[0] })
    for (const path of reads) expect(await t.call('/api/notes/read', { path }), path).toEqual(first)
    const imgs = ['no/existe.png', 'Privado/p.png', 'privado/P.PNG', '.oculto/x.png']
    const firstImg = await t.call('/api/notes/image', { target: imgs[0], from: '' })
    expect(firstImg.status).toBe(404)
    for (const target of imgs) expect(await t.call('/api/notes/image', { target, from: '' }), target).toEqual(firstImg)
    // `from` inside the excluded folder does not make a sibling-by-name fallback reach it.
    expect(await t.call('/api/notes/image', { target: 'p.png', from: 'Privado/grande.md' })).toEqual(firstImg)
    expect(await t.call('/api/notes/image', { target: '../Privado/p.png', from: 'Notas/x.md' })).toEqual(firstImg)
  })

  it('AC-1.9 (028 verify) a spelling of the exclusion (slashes, case, backslash, dot) excludes the same subtree and only that subtree', async () => {
    for (const spelling of ['Privado', 'privado/', '/Privado', '\\PRIVADO', './Privado', 'Privado/.', 'Privado//']) {
      const t = await served({ excluded: [spelling] })
      t.vault.put('Privado/a.md', 'x')
      t.vault.put('Privado/sub/deep/b.md', 'x')
      t.vault.put('Privado2/c.md', 'ok')
      t.vault.put('Privado.md', 'ok')
      t.vault.put('privadox/d.md', 'ok')
      expect((await t.call('/api/notes/read', { path: 'Privado/a.md' })).status, spelling).toBe(404)
      expect((await t.call('/api/notes/read', { path: 'Privado/sub/deep/b.md' })).status, spelling).toBe(404)
      for (const ok of ['Privado2/c.md', 'Privado.md', 'privadox/d.md']) expect((await t.call('/api/notes/read', { path: ok })).status, `${spelling} -> ${ok}`).toBe(200)
      const found = ((await t.call('/api/notes/find', { query: 'md' })).body as { found: { path: string }[] }).found.map((hit) => hit.path)
      expect(found.some((path) => /^privado\//i.test(path)), spelling).toBe(false)
    }
  })

  it('AC-1.9 (028 verify) excluding the vault root (blank-ish spellings that mean the root) fails closed', async () => {
    for (const root of ['/', '.', './', '\\', '..', 'a/..']) {
      const t = await served({ excluded: [root] })
      t.vault.put('Notas/ok.md', 'x')
      expect((await t.call('/api/notes/read', { path: 'Notas/ok.md' })).status, root).toBe(404)
      expect(((await t.call('/api/notes/list', { folder: '' })).body as { entries: unknown[] }).entries, root).toEqual([])
      expect(((await t.call('/api/notes/find', { query: 'ok' })).body as { found: unknown[] }).found, root).toEqual([])
    }
  })

  it('AC-1.9 (028 verify) an excluded note linked or embedded from a visible note is not served by file name fallback either', async () => {
    const t = await served({ excluded: ['Privado'] })
    t.vault.put('Notas/ok.md', 'x')
    t.vault.put('Privado/secreto.png', new Uint8Array([1, 2, 3]))
    for (const target of ['secreto.png', 'SECRETO.PNG', '../Privado/secreto.png', 'Privado/secreto.png', 'x/../Privado/secreto.png']) {
      expect(await t.call('/api/notes/image', { target, from: 'Notas/ok.md' }), target).toEqual(unavailable)
    }
    // And the same file, once it is no longer excluded, is served: the refusal was the exclusion, not the lookup.
    t.setRemote({ vaultExcluded: [] })
    expect((await t.call('/api/notes/image', { target: 'secreto.png', from: 'Notas/ok.md' })).status).toBe(200)
  })

  it('AC-7.4 (028 verify) a vault path longer than the schema bound or with extra keys never reaches the vault', async () => {
    const t = await served()
    t.vault.put('a.md', 'x')
    const before = { ...t.vault.reads }
    for (const body of [{ path: 'a'.repeat(1025) }, { path: 'a.md', extra: 1 }, { path: ['a.md'] }, { path: { toString: 'x' } }, 'a.md', null, [], { Path: 'a.md' }]) {
      expect((await t.call('/api/notes/read', body)).status, JSON.stringify(body)).toBe(400)
    }
    expect(t.vault.reads).toEqual(before)
  })
})

describe('AC-2.4 / AC-7.4 (028 verify) against the real vault code on disk', () => {
  const dirs: string[] = []
  const bases: KnowledgeBase[] = []
  afterEach(async () => {
    await Promise.all(bases.splice(0).map((base) => base.close()))
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function realFlow(excluded: string[]): Promise<{ notes: NotesFlow; opened: string[]; root: string; outside: string }> {
    const root = mkdtempSync(join(tmpdir(), 'alma-v28-vault-'))
    const outside = mkdtempSync(join(tmpdir(), 'alma-v28-out-'))
    const data = mkdtempSync(join(tmpdir(), 'alma-v28-data-'))
    dirs.push(root, outside, data)
    const base = new KnowledgeBase({
      root,
      dataDir: data,
      embedder: { modelId: 'fake', state: () => ({ state: 'idle' }), embed: async () => [] },
      trash: async () => {},
      onStatus: () => {},
      onChanged: () => {}
    })
    bases.push(base)
    const opened: string[] = []
    const settings = { ...defaultSettings(), remote: { ...defaultRemote(), vaultExcluded: excluded } }
    const notes = new NotesFlow({
      vault: () => ({
        state: () => 'ready',
        tree: () => base.tree(),
        readText: (path) => {
          opened.push(path)
          return base.read(path)
        },
        readBytes: (path, max) => {
          opened.push(path)
          return base.readBytes(path, max)
        }
      }),
      settings: () => settings
    })
    return { notes, opened, root, outside }
  }

  it('AC-2.4 (028 verify) on a case-insensitive disk, case and Windows aliases never open anything but the tree spelling of a reachable note', async () => {
    const { notes, opened, root } = await realFlow(['Privado'])
    mkdirSync(join(root, 'Notas'))
    mkdirSync(join(root, 'Privado'))
    mkdirSync(join(root, '.oculta'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'Notas', 'ok.md'), 'visible')
    writeFileSync(join(root, 'Privado', 'a.md'), 'secreto')
    writeFileSync(join(root, '.oculta', 'a.md'), 'oculto')
    writeFileSync(join(root, 'node_modules', 'a.md'), 'dep')
    const refused = ['PRIVADO/A.MD', 'privado\\a.md', 'Privado./a.md', 'Privado /a.md', 'Privado::$INDEX_ALLOCATION/a.md', '.oculta/a.md', '.OCULTA/a.md', 'node_modules/a.md', 'NODE_MODULES/a.md', 'Notas/ok.md.', 'Notas/ok.md ', 'Notas/ok.md::$DATA', 'Notas/../Privado/a.md', 'PRIVAD~1/a.md']
    for (const path of refused) expect(await notes.read(path), path).toEqual(unavailable)
    expect(opened).toEqual([])
    // A reachable note is opened under the spelling the tree has, whatever case the phone typed.
    expect((await notes.read('NOTAS/OK.MD')).body).toMatchObject({ path: 'Notas/ok.md', content: 'visible' })
    expect(opened).toEqual(['Notas/ok.md'])
  })

  it('AC-2.4 (028 verify) a junction out of the vault is not listed, read, found or served as an image, by any spelling', async () => {
    const { notes, opened, root, outside } = await realFlow([])
    mkdirSync(join(root, 'Notas'))
    writeFileSync(join(root, 'Notas', 'ok.md'), 'visible')
    writeFileSync(join(outside, 'secret.md'), 'FUERA')
    writeFileSync(join(outside, 'secret.png'), 'FUERA')
    symlinkSync(outside, join(root, 'Enlace'), 'junction')
    for (const path of ['Enlace/secret.md', 'enlace/SECRET.md', 'ENLACE\\secret.md', 'Notas/../Enlace/secret.md']) expect(await notes.read(path), path).toEqual(unavailable)
    expect(JSON.stringify((await notes.list('')).body)).not.toMatch(/enlace/i)
    expect(JSON.stringify((await notes.list('Enlace')).body)).not.toContain('secret')
    expect(JSON.stringify((await notes.find('secret')).body)).not.toContain('secret.md')
    expect(await notes.image('secret.png', 'Notas/ok.md')).toEqual(unavailable)
    expect(await notes.image('../Enlace/secret.png', 'Notas/ok.md')).toEqual(unavailable)
    expect(opened).toEqual([])
  })
})

describe('AC-2.5 / AC-2.11 (028 verify) size caps', () => {
  it('AC-2.5 (028 verify) 1 MB passes, 1 MB + 1 is too-large, a note whose listed size lies is still caught on the real text', async () => {
    const t = await served()
    t.vault.put('justo.md', 'a'.repeat(MB))
    t.vault.put('pasado.md', 'a'.repeat(MB + 1))
    t.vault.put('mentira.md', 'a'.repeat(MB + 10))
    // The tree claims a small size for the lying note.
    t.vault.entries = t.vault.entries.map((entry) => (entry.path === 'mentira.md' ? { ...entry, size: 5 } : entry))
    expect((await t.call('/api/notes/read', { path: 'justo.md' })).status).toBe(200)
    for (const path of ['pasado.md', 'mentira.md']) {
      expect(await t.call('/api/notes/read', { path }), path).toEqual({ status: 413, headers: { 'cache-control': 'no-store' }, body: { error: 'too-large' } })
    }
  })

  it('AC-2.11 (028 verify) a 2 MB image passes, 2 MB + 1 is too-large and is never read, an svg keeps its media type', async () => {
    const t = await served()
    t.vault.put('justa.png', new Uint8Array(2 * MB))
    t.vault.put('pasada.png', new Uint8Array(2 * MB + 1))
    t.vault.put('dibujo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
    expect((await t.call('/api/notes/image', { target: 'justa.png', from: '' })).status).toBe(200)
    const reads = t.vault.reads.readBytes
    expect(await t.call('/api/notes/image', { target: 'pasada.png', from: '' })).toEqual({ status: 413, headers: { 'cache-control': 'no-store' }, body: { error: 'too-large' } })
    expect(t.vault.reads.readBytes).toBe(reads)
    expect((await t.call('/api/notes/image', { target: 'dibujo.svg', from: '' })).body).toMatchObject({ mediaType: 'image/svg+xml' })
  })

  it('AC-2.14 (028 verify) a file that merely looks like an image or note is refused by its real extension, not its name tricks', async () => {
    const t = await served()
    t.vault.put('x.png.exe', 'MZ')
    t.vault.put('x.md.txt', 'texto')
    t.vault.put('img.png/inner.md', 'x')
    expect((await t.call('/api/notes/read', { path: 'x.md.txt' })).body).toEqual({ error: 'unsupported' })
    expect((await t.call('/api/notes/image', { target: 'x.png.exe', from: '' })).body).toEqual({ error: 'unsupported' })
    // A note opened as an image and an image opened as a note are both "unsupported", never served as the other kind.
    t.vault.put('n.md', 'texto')
    t.vault.put('p.png', new Uint8Array([1]))
    expect((await t.call('/api/notes/image', { target: 'n.md', from: '' })).body).toEqual({ error: 'unsupported' })
    expect((await t.call('/api/notes/read', { path: 'p.png' })).body).toEqual({ error: 'unsupported' })
  })
})

describe('AC-1.1 / AC-1.6 / AC-2.9 (028 verify) scopes and rate limit are checked per request', () => {
  const calls: [string, unknown][] = [
    ['/api/notes/list', { folder: '' }],
    ['/api/notes/find', { query: 'a' }],
    ['/api/notes/read', { path: 'a.md' }],
    ['/api/notes/image', { target: 'a.png', from: '' }]
  ]

  it('AC-1.1 (028 verify) no other scope, nor History, grants Notes; Notes alone does not grant conversations', async () => {
    const t = await served({ scopes: { vault: false, chat: true, approve: true, home: true, cameras: true, history: true } })
    t.setRemote({ sensitive: true, continueHistory: true })
    for (const [path, body] of calls) expect((await t.call(path, body)).body, path).toEqual({ error: 'scope-off' })
    expect(t.vault.reads).toEqual({ tree: 0, readText: 0, readBytes: 0 })
    const only = await served({ scopes: { vault: true } })
    only.setRemote({ continueHistory: true })
    for (const [path, body] of [['/api/threads/list', { offset: 0 }], ['/api/threads/read', { id: 'remote' }], ['/api/threads/send', { id: 'remote', text: 'x' }], ['/api/threads/stop', { id: 'remote' }]] as [string, unknown][]) {
      expect((await only.call(path, body)).body, path).toEqual({ error: 'scope-off' })
    }
  })

  it('AC-1.1 (028 verify) a scope turned off between two requests of the same session refuses the second one at once, with no content', async () => {
    const t = await served()
    t.vault.put('a.md', 'contenido')
    expect((await t.call('/api/notes/read', { path: 'a.md' })).body).toMatchObject({ content: 'contenido' })
    t.setRemote({ scopes: { ...defaultRemote().scopes, vault: false } })
    const res = await t.call('/api/notes/read', { path: 'a.md' })
    expect(res.body).toEqual({ error: 'scope-off' })
    expect(JSON.stringify(res)).not.toContain('contenido')
  })

  it('AC-2.9 (028 verify) 60 mixed note requests pass, the 61st is rate-limited even when it would have been refused, and a minute later it recovers', async () => {
    const t = await served()
    t.vault.put('a.md', 'x')
    for (let i = 0; i < 60; i++) expect((await t.call('/api/notes/read', { path: i % 2 ? 'a.md' : 'falta.md' })).status).toBeLessThan(429)
    expect(await t.call('/api/notes/image', { target: 'a.png', from: '' })).toMatchObject({ status: 429, body: { error: 'rate-limited' } })
    expect(await t.call('/api/notes/read', { path: 'a.md' })).toMatchObject({ status: 429 })
    t.setNow(61_000)
    expect((await t.call('/api/notes/read', { path: 'a.md' })).status).toBe(200)
  })

  it('AC-2.2 (028 verify) with no vault open every route says so (or unavailable) and nothing is read', async () => {
    const t = await served()
    t.vault.put('a.md', 'x')
    t.vault.active = 'none'
    expect((await t.call('/api/notes/list', { folder: '' })).body).toEqual({ vault: 'none' })
    expect((await t.call('/api/notes/find', { query: 'a' })).body).toEqual({ vault: 'none' })
    expect(await t.call('/api/notes/read', { path: 'a.md' })).toEqual(unavailable)
    expect(await t.call('/api/notes/image', { target: 'a.png', from: '' })).toEqual(unavailable)
    expect(t.vault.reads).toEqual({ tree: 0, readText: 0, readBytes: 0 })
  })
})

describe('AC-2.10 (028 verify) name filter', () => {
  it('AC-2.10 (028 verify) at most 50 results, never content, never hidden or excluded, empty and blank queries list nothing', async () => {
    const t = await served({ excluded: ['Privado'] })
    for (let i = 0; i < 80; i++) t.vault.put(`Notas/idea-${i}.md`, 'texto')
    t.vault.put('Privado/idea-secreta.md', 'x')
    t.vault.put('Notas/otra.md', 'palabra-en-el-contenido')
    const found = ((await t.call('/api/notes/find', { query: 'idea' })).body as { found: { path: string }[] }).found
    expect(found).toHaveLength(50)
    expect(found.some((hit) => hit.path.startsWith('Privado'))).toBe(false)
    expect(((await t.call('/api/notes/find', { query: 'palabra-en-el-contenido' })).body as { found: unknown[] }).found).toEqual([])
    for (const query of ['', ' ', '\t\n']) expect(((await t.call('/api/notes/find', { query })).body as { found: unknown[] }).found, JSON.stringify(query)).toEqual([])
  })

  it('AC-2.10 (028 verify) regex metacharacters and very long queries are plain characters, not patterns', () => {
    const entries = [{ path: 'a.b.md', kind: 'file' as const, size: 1, mtime: 1 }, { path: 'axb.md', kind: 'file' as const, size: 1, mtime: 1 }]
    expect(findByName(entries, '.*', []).map((hit) => hit.path)).toEqual([])
    expect(findByName(entries, '(((', [])).toEqual([])
    expect(() => findByName(entries, 'a'.repeat(200), [])).not.toThrow()
  })
})

describe('AC-1.9 / AC-1.11 (028 verify) exclusion list logic', () => {
  it('AC-1.11 (028 verify) a rename inside Alma carries the exclusion and its children, case-insensitively, and a sibling with the same prefix stays put', () => {
    expect(moveExclusions(['Privado', 'privado/sub', 'Privado2', 'Otro'], 'PRIVADO', 'Archivo/Privado')).toEqual(['Archivo/Privado', 'Archivo/Privado/sub', 'Privado2', 'Otro'])
    expect(moveExclusions(['A\\B'], 'a', 'z')).toEqual(['z/B'])
    expect(moveExclusions(['A'], '', 'z')).toEqual(['A'])
    expect(moveExclusions(['A'], '.', 'z')).toEqual(['A'])
  })

  it('AC-1.11 (028 verify) a folder moved outside Alma is listed as stale and its new place is not excluded', () => {
    const entries = [{ path: 'Nuevo', kind: 'folder' as const, size: 0, mtime: 0 }, { path: 'Nuevo/a.md', kind: 'file' as const, size: 1, mtime: 0 }]
    expect(staleExclusions(['Privado', 'nuevo', '/'], entries)).toEqual(['Privado'])
    expect(isExcluded('Nuevo/a.md', ['Privado'])).toBe(false)
  })

  it('AC-1.8 (028 verify) toggling is idempotent, and unticking drops every spelling', () => {
    expect(toggleExclusion(['Privado'], 'privado/', true)).toEqual(['Privado'])
    expect(toggleExclusion(['Privado', 'privado', '/PRIVADO/', 'Otro'], 'Privado', false)).toEqual(['Otro'])
  })

  it('AC-1.9 (028 verify) canonical paths cannot be made to differ by separators, dots or case', () => {
    const base = canonicalVaultPath('Privado/Sub/a.md')
    for (const alt of ['privado\\sub\\A.MD', '/Privado//Sub/./a.md', 'x/../Privado/Sub/a.md', 'PRIVADO/SUB/A.md']) expect(canonicalVaultPath(alt), alt).toBe(base)
    expect(isReachable('Notas/ok.md', [])).toBe(true)
    expect(isReachable('', [])).toBe(true)
    for (const bad of ['..', '../x', 'a/../x', '.x', 'a/.x/b', 'a/b.', 'a/b ', 'a:b', 'C:', '/x', '\\x', 'node_modules', 'a/Node_Modules/b', 'a/\u001fb']) expect(isReachable(bad, []), bad).toBe(false)
  })
})
