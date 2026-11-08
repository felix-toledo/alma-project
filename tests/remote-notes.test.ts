import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NotesFlow } from '../src/coordinator/channels/remote/notes'
import { KnowledgeBase } from '../src/coordinator/knowledge/base'
import { defaultSettings } from '../src/shared/defaults'
import { defaultRemote } from '../src/shared/remote/settings'
import type { Language } from '../src/shared/i18n/language'
import { fakeVault, HOST, testChannel, type FakeVault, type Harness } from './support/remote-harness'

function flow(options: { excluded?: string[]; language?: Language } = {}): { notes: NotesFlow; vault: FakeVault } {
  const vault = fakeVault()
  const settings = { ...defaultSettings(), language: options.language ?? 'es', remote: { ...defaultRemote(), vaultExcluded: options.excluded ?? [] } }
  return { notes: new NotesFlow({ vault: () => vault, settings: () => settings }), vault }
}

describe('notes: list and find (spec 028 T19)', () => {
  it('AC-2.1 (028) list returns name, kind, size, mtime and no absolute path', async () => {
    const { notes, vault } = flow()
    vault.put('Diario/hoy.md', 'hola', { mtime: 77 })
    vault.put('top.md', 'x')
    const res = await notes.list('Diario')
    expect(res.status).toBe(200)
    expect(res.headers).toEqual({ 'cache-control': 'no-store' })
    expect(res.body).toEqual({ folder: 'Diario', entries: [{ name: 'hoy.md', kind: 'file', size: 4, mtime: 77 }] })
    const root = (await notes.list('')).body as { entries: { name: string; kind: string }[] }
    expect(root.entries.map((entry) => `${entry.kind}:${entry.name}`)).toEqual(['folder:Diario', 'file:top.md'])
  })

  it('AC-1.9 (028) an excluded or hidden folder is not listed, and listing it answers like a folder that does not exist', async () => {
    const { notes, vault } = flow({ excluded: ['Privado'] })
    vault.put('Privado/a.md', 'secreto')
    vault.put('Abierto/b.md', 'ok')
    vault.put('.git/c.md', 'x', { listed: false })
    const root = (await notes.list('')).body as { entries: { name: string }[] }
    expect(root.entries.map((entry) => entry.name)).toEqual(['Abierto'])
    expect((await notes.list('Privado')).body).toEqual({ folder: 'Privado', entries: [] })
    expect((await notes.list('.git')).body).toEqual({ folder: '.git', entries: [] })
    expect((await notes.list('Nunca')).body).toEqual({ folder: 'Nunca', entries: [] })
  })

  it('AC-2.2 (028) no vault and empty folder are different states', async () => {
    const { notes, vault } = flow()
    vault.put('Vacia/.keep', '', { listed: false })
    vault.entries.push({ path: 'Vacia', kind: 'folder', size: 0, mtime: 0 })
    expect((await notes.list('Vacia')).body).toEqual({ folder: 'Vacia', entries: [] })
    vault.active = 'none'
    expect((await notes.list('Vacia')).body).toEqual({ vault: 'none' })
    expect((await notes.find('a')).body).toEqual({ vault: 'none' })
    const absent = new NotesFlow({ vault: () => null, settings: () => defaultSettings() })
    expect((await absent.list('')).body).toEqual({ vault: 'none' })
    const broken = fakeVault()
    broken.tree = async () => {
      throw new Error('ENOENT')
    }
    const gone = new NotesFlow({ vault: () => broken, settings: () => defaultSettings() })
    expect((await gone.list('')).body).toEqual({ vault: 'none' })
  })

  it('AC-2.10 (028) find reaches the whole reachable vault', async () => {
    const { notes, vault } = flow({ excluded: ['Privado'] })
    vault.put('A/B/idea-profunda.md', 'x')
    vault.put('idea-suelta.md', 'x')
    vault.put('Privado/idea-secreta.md', 'x')
    vault.put('.oculto/idea-oculta.md', 'x', { listed: false })
    const res = await notes.find('idea')
    expect(res.status).toBe(200)
    const { found } = res.body as { found: { path: string; name: string }[] }
    expect(found.map((hit) => hit.path).sort()).toEqual(['A/B/idea-profunda.md', 'idea-suelta.md'])
    expect(found.find((hit) => hit.path === 'idea-suelta.md')?.name).toBe('idea-suelta.md')
    expect(((await notes.find('')).body as { found: unknown[] }).found).toEqual([])
  })
})

describe('notes: read (spec 028 T20)', () => {
  const unavailable = { status: 404, headers: { 'cache-control': 'no-store' }, body: { error: 'unavailable' } }

  it('AC-2.3 (028) UTF-8 text with CRLF is served as is, under the path the vault really has', async () => {
    const { notes, vault } = flow()
    const text = '---\r\ntitulo: ñandú\r\n---\r\nlínea 😀\r\n\r\n[[wiki]]\r\n'
    vault.put('Diario/Hoy.md', text, { mtime: 42 })
    const res = await notes.read('Diario/Hoy.md')
    expect(res).toEqual({ status: 200, headers: { 'cache-control': 'no-store' }, body: { path: 'Diario/Hoy.md', content: text, mtime: 42 } })
    expect((await notes.read('diario\\HOY.md')).body).toEqual({ path: 'Diario/Hoy.md', content: text, mtime: 42 })
  })

  it('AC-2.4 (028) missing, folder, .., absolute, dot segment, 8.3 alias, junction, node_modules and excluded give byte-identical answers', async () => {
    const { notes, vault } = flow({ excluded: ['Privado Total'] })
    vault.put('Notas/ok.md', 'visible')
    vault.put('Privado Total/a.md', 'secreto')
    vault.put('Privado Total/enorme.md', 'x'.repeat(6 * 1024 * 1024))
    vault.put('.git/config.md', 'oculto', { listed: false })
    vault.put('node_modules/x/readme.md', 'dep', { listed: false })
    vault.put('PRIVAT~1/a.md', 'secreto por el alias 8.3', { listed: false })
    vault.put('enlace/secret.md', 'detras de una junction', { listed: false })
    vault.put('/etc/passwd.md', 'absoluto', { listed: false })
    const paths = [
      'Notas/no-existe.md',
      'Notas',
      '',
      '../afuera.md',
      'Notas/../../afuera.md',
      '/etc/passwd.md',
      'C:\\Windows\\system.ini',
      '.git/config.md',
      'node_modules/x/readme.md',
      'PRIVAT~1/a.md',
      'enlace/secret.md',
      'Privado Total/a.md',
      'privado total/A.MD',
      'Privado Total\\a.md',
      'Privado Total/enorme.md',
      'Privado Total/../Privado Total/a.md'
    ]
    for (const path of paths) expect(await notes.read(path), path).toEqual(unavailable)
    expect(vault.reads.readText).toBe(0)
    expect((await notes.read('Notas/ok.md')).status).toBe(200)
  })

  it('AC-2.5 (028) exactly 1 MB passes, +1 byte is too-large, nothing partial, measured on UTF-8 bytes', async () => {
    const { notes, vault } = flow()
    vault.put('justo.md', 'a'.repeat(1_048_576))
    vault.put('pasado.md', 'a'.repeat(1_048_577))
    vault.put('acentos.md', 'ñ'.repeat(524_289))
    expect((await notes.read('justo.md')).status).toBe(200)
    expect(vault.reads.readText).toBe(1)
    for (const path of ['pasado.md', 'acentos.md']) {
      const res = await notes.read(path)
      expect(res).toEqual({ status: 413, headers: { 'cache-control': 'no-store' }, body: { error: 'too-large' } })
    }
    // A note that grew after the listing is still caught on the bytes actually read.
    vault.entries = vault.entries.map((entry) => (entry.path === 'pasado.md' ? { ...entry, size: 10 } : entry))
    expect((await notes.read('pasado.md')).status).toBe(413)
  })

  it('AC-2.6 (028) a changed note serves the current text; a deleted one, even mid-read, is unavailable', async () => {
    const { notes, vault } = flow()
    vault.put('viva.md', 'v1', { mtime: 1 })
    expect((await notes.read('viva.md')).body).toMatchObject({ content: 'v1', mtime: 1 })
    vault.put('viva.md', 'v2', { mtime: 2 })
    expect((await notes.read('viva.md')).body).toMatchObject({ content: 'v2', mtime: 2 })
    const listedThenGone = vault.readText.bind(vault)
    vault.remove('viva.md')
    vault.put('fantasma.md', 'x')
    vault.readText = async (path) => {
      vault.remove(path)
      return listedThenGone(path)
    }
    expect(await notes.read('fantasma.md')).toEqual(unavailable)
    expect(await notes.read('viva.md')).toEqual(unavailable)
  })

  it('AC-2.14 (028) a reachable non-md file is unsupported and still listed; a missing or excluded one is unavailable', async () => {
    const { notes, vault } = flow({ excluded: ['Privado'] })
    vault.put('Docs/plano.pdf', 'pdf')
    vault.put('Docs/dibujo.excalidraw', '{}')
    vault.put('Privado/otro.pdf', 'pdf')
    const listed = (await notes.list('Docs')).body as { entries: { name: string }[] }
    expect(listed.entries.map((entry) => entry.name)).toEqual(['dibujo.excalidraw', 'plano.pdf'])
    const unsupported = { status: 415, headers: { 'cache-control': 'no-store' }, body: { error: 'unsupported' } }
    expect(await notes.read('Docs/plano.pdf')).toEqual(unsupported)
    expect(await notes.read('Docs/dibujo.excalidraw')).toEqual(unsupported)
    expect(await notes.read('Docs/falta.pdf')).toEqual(unavailable)
    expect(await notes.read('Privado/otro.pdf')).toEqual(unavailable)
    expect(vault.reads.readText).toBe(0)
  })

  it('AC-2.2 (028) reading with no vault open is unavailable and touches nothing', async () => {
    const { notes, vault } = flow()
    vault.put('a.md', 'x')
    vault.active = 'none'
    expect(await notes.read('a.md')).toEqual(unavailable)
    expect(vault.reads).toEqual({ tree: 0, readText: 0, readBytes: 0 })
  })
})

describe('notes: images (spec 028 T21)', () => {
  const unavailable = { status: 404, headers: { 'cache-control': 'no-store' }, body: { error: 'unavailable' } }
  const tooLarge = { status: 413, headers: { 'cache-control': 'no-store' }, body: { error: 'too-large' } }
  const BYTES = new Uint8Array([137, 80, 78, 71, 1, 2, 3])

  it('AC-2.11 (028) an image resolves relative to the note, by exact path or by file name, with its media type', async () => {
    const { notes, vault } = flow()
    vault.put('Notas/img/foto.PNG', BYTES)
    vault.put('Otros/dibujo.svg', BYTES)
    const expected = { status: 200, headers: { 'cache-control': 'no-store' }, body: { photo: Buffer.from(BYTES).toString('base64'), mediaType: 'image/png' } }
    expect(await notes.image('img/foto.PNG', 'Notas/hoy.md')).toEqual(expected)
    expect(await notes.image('Notas/img/foto.PNG', '')).toEqual(expected)
    expect(await notes.image('foto.png', 'Lejos/otra.md')).toEqual(expected)
    expect(((await notes.image('dibujo.svg', '')).body as { mediaType: string }).mediaType).toBe('image/svg+xml')
  })

  it('AC-2.11 (028) 2 MB passes, +1 byte is too-large without reading it', async () => {
    const { notes, vault } = flow()
    vault.put('justo.png', new Uint8Array(2_097_152))
    vault.put('pasada.png', new Uint8Array(2_097_153))
    expect((await notes.image('justo.png', '')).status).toBe(200)
    expect(vault.reads.readBytes).toBe(1)
    expect(await notes.image('pasada.png', '')).toEqual(tooLarge)
    expect(vault.reads.readBytes).toBe(1)
    // Grew after the listing: the vault's own cap on the read still refuses it.
    vault.entries = vault.entries.map((entry) => (entry.path === 'pasada.png' ? { ...entry, size: 10 } : entry))
    expect(await notes.image('pasada.png', '')).toEqual(tooLarge)
  })

  it('AC-1.9 (028) an embedded image in an excluded or hidden folder is not served, typed, linked or found by name', async () => {
    const { notes, vault } = flow({ excluded: ['Privado'] })
    vault.put('Privado/foto.png', BYTES)
    vault.put('.oculto/dentro.png', BYTES, { listed: false })
    vault.put('Privado/enorme.png', new Uint8Array(3_000_000))
    for (const [target, from] of [
      ['Privado/foto.png', ''],
      ['foto.png', 'Notas/hoy.md'],
      ['../Privado/foto.png', 'Notas/hoy.md'],
      ['.oculto/dentro.png', ''],
      ['dentro.png', ''],
      ['Privado/enorme.png', ''],
      ['no-existe.png', ''],
      ['https://evil.example/x.png', 'Notas/hoy.md']
    ]) {
      expect(await notes.image(target, from), `${target} from ${from}`).toEqual(unavailable)
    }
    expect(vault.reads.readBytes).toBe(0)
  })

  it('AC-2.14 (028) a reachable target that is not an image is unsupported, never read', async () => {
    const { notes, vault } = flow()
    vault.put('Docs/plano.pdf', BYTES)
    vault.put('Docs/nota.md', 'texto')
    const unsupported = { status: 415, headers: { 'cache-control': 'no-store' }, body: { error: 'unsupported' } }
    expect(await notes.image('Docs/plano.pdf', '')).toEqual(unsupported)
    expect(await notes.image('Docs/nota.md', '')).toEqual(unsupported)
    expect(vault.reads.readBytes).toBe(0)
  })
})

describe('notes over a real vault (spec 028 T21)', () => {
  const dirs: string[] = []
  const bases: KnowledgeBase[] = []
  afterEach(async () => {
    await Promise.all(bases.splice(0).map((base) => base.close()))
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('AC-7.4 (028) a junction that leaves the vault is neither listed nor read nor served as an image', async () => {
    const root = mkdtempSync(join(tmpdir(), 'alma-vault-'))
    const outside = mkdtempSync(join(tmpdir(), 'alma-outside-'))
    const data = mkdtempSync(join(tmpdir(), 'alma-data-'))
    dirs.push(root, outside, data)
    mkdirSync(join(root, 'Notas'))
    writeFileSync(join(root, 'Notas', 'ok.md'), 'visible')
    writeFileSync(join(root, 'Notas', 'p.png'), 'PNG')
    writeFileSync(join(outside, 'secret.md'), 'fuera')
    writeFileSync(join(outside, 'secret.png'), 'fuera')
    symlinkSync(outside, join(root, 'enlace'), 'junction')
    const base = new KnowledgeBase({
      root,
      dataDir: data,
      embedder: { modelId: 'fake', state: () => ({ state: 'idle' }), embed: async () => [] },
      trash: async () => {},
      onStatus: () => {},
      onChanged: () => {}
    })
    bases.push(base)
    const notes = new NotesFlow({
      vault: () => ({ state: () => 'ready', tree: () => base.tree(), readText: (path) => base.read(path), readBytes: (path, max) => base.readBytes(path, max) }),
      settings: () => defaultSettings()
    })
    expect((await notes.read('Notas/ok.md')).body).toMatchObject({ content: 'visible' })
    expect((await notes.image('p.png', 'Notas/ok.md')).status).toBe(200)
    const names = ((await notes.list('')).body as { entries: { name: string }[] }).entries.map((entry) => entry.name)
    expect(names).toEqual(['Notas'])
    const unavailable = { status: 404, headers: { 'cache-control': 'no-store' }, body: { error: 'unavailable' } }
    expect(await notes.read('enlace/secret.md')).toEqual(unavailable)
    expect(await notes.image('enlace/secret.png', '')).toEqual(unavailable)
    expect(await notes.image('secret.png', 'Notas/ok.md')).toEqual(unavailable)
  })
})

describe('notes through the channel (spec 028 T22)', () => {
  const ROUTES = ['/api/notes/list', '/api/notes/find', '/api/notes/read', '/api/notes/image']
  const BODIES: Record<string, unknown> = {
    '/api/notes/list': { folder: '' },
    '/api/notes/find': { query: 'hola' },
    '/api/notes/read': { path: 'Notas/hola.md' },
    '/api/notes/image': { target: 'p.png', from: '' }
  }

  async function served(vaultOn = true): Promise<Harness> {
    const remote = { ...defaultRemote(), enabled: true, scopes: { ...defaultRemote().scopes, vault: vaultOn } }
    const t = await testChannel({ remote })
    await t.channel.sync()
    t.vault.put('Notas/hola.md', 'hola mundo')
    t.vault.put('Notas/p.png', new Uint8Array([1, 2, 3]))
    return t
  }

  it('AC-1.1 (028) Notes off reads nothing from disk on any of the four routes', async () => {
    const t = await served(false)
    for (const path of ROUTES) {
      const res = await t.call(path, BODIES[path])
      expect(res.status, path).toBe(403)
      expect(res.body).toEqual({ error: 'scope-off' })
    }
    expect(t.vault.reads).toEqual({ tree: 0, readText: 0, readBytes: 0 })
  })

  it('AC-1.1 (028) with Notes on the four routes answer from the vault', async () => {
    const t = await served()
    expect((await t.call('/api/notes/list', { folder: 'Notas' })).body).toMatchObject({ folder: 'Notas' })
    expect((await t.call('/api/notes/find', { query: 'hola' })).body).toMatchObject({ found: [{ path: 'Notas/hola.md' }] })
    expect((await t.call('/api/notes/read', { path: 'Notas/hola.md' })).body).toMatchObject({ content: 'hola mundo' })
    expect((await t.call('/api/notes/image', { target: 'p.png', from: 'Notas/hola.md' })).body).toMatchObject({ mediaType: 'image/png' })
  })

  it('AC-2.9 (028) list, read and image share the 60 per minute limit', async () => {
    const t = await served()
    for (let i = 0; i < 20; i++) {
      expect((await t.call('/api/notes/list', { folder: '' })).status).toBe(200)
      expect((await t.call('/api/notes/read', { path: 'Notas/hola.md' })).status).toBe(200)
      expect((await t.call('/api/notes/image', { target: 'p.png', from: '' })).status).toBe(200)
    }
    const over = await t.call('/api/notes/list', { folder: '' })
    expect(over).toMatchObject({ status: 429, body: { error: 'rate-limited' } })
  })

  it('AC-2.8 (028) a malformed body never reaches the handler', async () => {
    const t = await served()
    const bad: [string, unknown][] = [
      ['/api/notes/list', {}],
      ['/api/notes/list', { folder: 5 }],
      ['/api/notes/list', { folder: 'x'.repeat(1025) }],
      ['/api/notes/list', { folder: '', extra: true }],
      ['/api/notes/find', { query: 'x'.repeat(201) }],
      ['/api/notes/read', { path: null }],
      ['/api/notes/image', { target: 'p.png' }]
    ]
    for (const [path, body] of bad) {
      expect(await t.call(path, body), path).toMatchObject({ status: 400, body: { error: 'invalid' } })
    }
    expect(t.vault.reads).toEqual({ tree: 0, readText: 0, readBytes: 0 })
  })

  it('AC-1.6 (028) the next request after Notes is turned off is scope-off, and on again it serves', async () => {
    const t = await served()
    expect((await t.call('/api/notes/read', { path: 'Notas/hola.md' })).status).toBe(200)
    t.setRemote({ scopes: { ...defaultRemote().scopes, vault: false } })
    expect(await t.call('/api/notes/read', { path: 'Notas/hola.md' })).toMatchObject({ status: 403, body: { error: 'scope-off' } })
    t.setRemote({ scopes: { ...defaultRemote().scopes, vault: true } })
    expect((await t.call('/api/notes/read', { path: 'Notas/hola.md' })).status).toBe(200)
  })

  it('AC-1.6 (028) the exclusion list and the vault are read at each request', async () => {
    const t = await served()
    expect((await t.call('/api/notes/read', { path: 'Notas/hola.md' })).status).toBe(200)
    t.setRemote({ vaultExcluded: ['Notas'] })
    expect((await t.call('/api/notes/read', { path: 'Notas/hola.md' })).body).toEqual({ error: 'unavailable' })
    t.setRemote({ vaultExcluded: [] })
    t.vault.active = 'none'
    expect((await t.call('/api/notes/list', { folder: '' })).body).toEqual({ vault: 'none' })
  })

  it('AC-1.7 (028) an unknown device or a bad token gets the refusal every other route gives', async () => {
    const t = await served()
    const reference = await t.transport.request({ method: 'POST', path: '/api/chat/send', headers: { ...HOST }, body: { text: 'x' } })
    for (const path of ROUTES) {
      for (const headers of [{ ...HOST }, { ...HOST, authorization: 'Bearer nope' }]) {
        expect(await t.transport.request({ method: 'POST', path, headers, body: BODIES[path] }), path).toEqual(reference)
      }
    }
    expect(reference).toMatchObject({ status: 401, body: { error: 'unknown-device' } })
    expect(t.vault.reads).toEqual({ tree: 0, readText: 0, readBytes: 0 })
  })

  it('AC-4.1 (028) notes responses carry Cache-Control no-store, served or refused', async () => {
    const t = await served()
    for (const path of ROUTES) {
      expect((await t.call(path, BODIES[path])).headers).toEqual({ 'cache-control': 'no-store' })
    }
    expect((await t.call('/api/notes/read', { path: 'Notas/falta.md' })).headers).toEqual({ 'cache-control': 'no-store' })
    expect((await t.call('/api/notes/list', { folder: 5 })).headers).toEqual({ 'cache-control': 'no-store' })
  })

  it('AC-2.7 (028) no response body contains the vault root, even when the vault fails with it in the message', async () => {
    const t = await served()
    const failing = new Error('ENOENT: no such file C:/Users/me/MiBoveda/Notas/hola.md')
    t.vault.readText = async () => {
      throw failing
    }
    t.vault.readBytes = async () => {
      throw failing
    }
    const bodies = [await t.call('/api/notes/read', { path: 'Notas/hola.md' }), await t.call('/api/notes/image', { target: 'p.png', from: '' })]
    t.vault.tree = async () => {
      throw failing
    }
    bodies.push(await t.call('/api/notes/list', { folder: '' }), await t.call('/api/notes/find', { query: 'h' }))
    for (const res of bodies) expect(JSON.stringify(res)).not.toMatch(/MiBoveda|Users/)
  })
})
