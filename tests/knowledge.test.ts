import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, symlinkSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ftsQuery, KnowledgeBase, MEMORY_FILE, parseMemories } from '../src/coordinator/knowledge/base'
import { ToolError } from '../src/coordinator/tools/types'
import { EMBEDDING_DIMS } from '../src/coordinator/knowledge/db'
import type { Embedder } from '../src/coordinator/knowledge/embedder'
import { chunkMarkdown, splitFrontmatter } from '../src/coordinator/knowledge/markdown'

/** Bag-of-words hashed into 1024 dims: texts sharing words point the same way, like a (very) poor embedding model. */
function fakeEmbedder(): Embedder & { calls: number } {
  return {
    modelId: 'fake',
    calls: 0,
    state: () => ({ state: 'ready' }),
    async embed(texts) {
      this.calls += texts.length
      return texts.map((text) => {
        const v = new Float32Array(EMBEDDING_DIMS)
        for (const word of text.toLowerCase().match(/[\p{L}]{3,}/gu) ?? []) {
          let h = 0
          for (const c of word) h = (h * 31 + c.charCodeAt(0)) % EMBEDDING_DIMS
          v[h] += 1
        }
        const norm = Math.hypot(...v) || 1
        return v.map((x) => x / norm)
      })
    }
  }
}

let dirs: string[] = []
let bases: KnowledgeBase[] = []
afterEach(async () => {
  await Promise.all(bases.map((b) => b.close()))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  bases = []
})

async function openVault(files: Record<string, string>, embedder = fakeEmbedder()) {
  const root = mkdtempSync(join(tmpdir(), 'alma-vault-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'alma-data-'))
  dirs.push(root, dataDir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const trashed: string[] = []
  const kb = new KnowledgeBase({
    root,
    dataDir,
    embedder,
    trash: async (path) => {
      trashed.push(path)
      rmSync(path, { recursive: true, force: true })
    },
    onStatus: () => {},
    onChanged: () => {}
  })
  bases.push(kb)
  await kb.scan()
  await waitFor(() => kb.status().pending === 0)
  return { kb, root, dataDir, embedder, trashed }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((r) => setTimeout(r, 10))
  expect(condition()).toBe(true)
}

describe('markdown', () => {
  it('chunks by heading, keeps the heading path and line, and skips frontmatter', () => {
    const text = `---\norigen: ia\n---\n# Proyecto\n\n${'Intro larga del proyecto. '.repeat(12)}\n\n## Ideas\n\n${'Una idea con detalle suficiente. '.repeat(10)}\n\n\`\`\`\n# no es un título\n\`\`\``
    const chunks = chunkMarkdown(text)
    expect(chunks.map((c) => c.heading)).toEqual(['Proyecto', 'Proyecto › Ideas'])
    expect(chunks[1].body).toContain('# no es un título')
    expect(chunks[1].line).toBe(9)
    expect(splitFrontmatter(text).data).toEqual({ origen: 'ia' })
  })

  it('splits oversized sections under the size limit', () => {
    const chunks = chunkMarkdown(`# Largo\n\n${Array.from({ length: 30 }, (_, i) => `Párrafo ${i} ${'texto '.repeat(30)}`).join('\n\n')}`)
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((c) => c.body.length <= 1600)).toBe(true)
  })

  it('builds safe FTS queries and parses memory lines', () => {
    expect(ftsQuery('¿Cuál es la "receta" de empanadas?')).toBe('"cuál"* OR "receta"* OR "empanadas"*')
    expect(ftsQuery('de la y')).toBe('')
    expect(parseMemories('# Recuerdos\n\ntexto\n- uno\n* dos\n')).toEqual(['uno', 'dos'])
  })
})

// Real SQLite on a temp folder: on Windows (antivirus, parallel test files) one test can take several seconds.
describe('KnowledgeBase', { timeout: 30_000 }, () => {
  it('indexes the vault and finds notes by keyword and by meaning', async () => {
    const { kb } = await openVault({
      'Cocina/Empanadas.md': '# Empanadas\n\nCarne cortada a cuchillo, cebolla, comino y horno fuerte quince minutos.',
      'Salud/Dentista.md': '# Turnos\n\nTurno con el dentista el martes a las diez de la mañana.',
      '.interna/app.md': 'carne secreta interna'
    })
    expect(kb.status()).toMatchObject({ files: 2, pending: 0 })
    const hits = await kb.search('carne al horno')
    expect(hits[0]).toMatchObject({ path: 'Cocina/Empanadas.md', heading: 'Empanadas' })
    expect(hits[0].similarity).toBeGreaterThan(0)
    expect(hits.some((h) => h.path.startsWith('.interna'))).toBe(false)
  })

  it('recalls only related fragments plus every memory', async () => {
    const { kb } = await openVault({
      'Salud/Dentista.md': '# Turnos\n\nTurno con el dentista el martes a las diez.',
      'Cocina/Empanadas.md': '# Empanadas\n\nCarne cortada a cuchillo y horno fuerte.'
    })
    await kb.remember('Vive en Buenos Aires')
    const { memories, fragments } = await kb.recall('¿cuándo es el turno con el dentista?')
    expect(memories).toEqual(['Vive en Buenos Aires'])
    expect(fragments.map((f) => f.path)).toEqual(['Salud/Dentista.md'])
  })

  it('reindexes only what changed and keeps vectors across a rename', async () => {
    const { kb, root, embedder } = await openVault({ 'a.md': '# A\n\nprimer texto', 'b.md': '# B\n\nsegundo texto' })
    const before = embedder.calls
    await kb.scan()
    expect(embedder.calls).toBe(before)

    await rename(join(root, 'a.md'), join(root, 'renombrada.md'))
    await kb.scan()
    expect(embedder.calls).toBe(before)
    expect((await kb.search('primer'))[0].path).toBe('renombrada.md')

    const beforeEdit = embedder.calls
    writeFileSync(join(root, 'b.md'), '# B\n\ntexto cambiado por completo')
    await kb.scan()
    await waitFor(() => kb.status().pending === 0)
    expect(embedder.calls).toBe(beforeEdit + 1)
    expect((await kb.search('cambiado'))[0].path).toBe('b.md')
  })

  it('remembers, refuses duplicates and forgets, keeping the user prose in Recuerdos.md', async () => {
    const { kb, root } = await openVault({})
    expect(await kb.remember('Prefiere respuestas cortas')).toContain('Remembered')
    expect(await kb.remember('prefiere  respuestas CORTAS')).toContain('I already remembered it')
    await kb.remember('Trabaja con Electron')
    await expect(kb.forget('Python')).rejects.toThrow(/No memory matches/)
    await kb.forget('cortas')
    expect(await kb.memories()).toEqual(['Trabaja con Electron'])
    expect(readFileSync(join(root, ...MEMORY_FILE.split('/')), 'utf8')).toContain('Lo que Alma recuerda de vos')
  })

  it('saves knowledge, dedupes near-identical notes and only updates its own notes', async () => {
    const { kb } = await openVault({ 'Mias/Idea.md': '# Idea\n\nUsar sqlite vec para busqueda vectorial local en electron' })
    const first = await kb.saveKnowledge({ title: 'Tiempos de bge-m3', content: 'En un Ryzen 5 5600G cada fragmento tarda 370 ms en CPU.', threadId: 't1' })
    expect(first).toMatchObject({ created: true, path: 'Alma/Conocimientos/Tiempos-de-bge-m3.md' })
    const note = (await kb.read(first.path)).content
    expect(splitFrontmatter(note).data).toMatchObject({ origen: 'ia', conversacion: 't1' })

    await waitFor(() => kb.status().pending === 0)
    const again = await kb.saveKnowledge({ title: 'Tiempos de bge-m3', content: 'En un Ryzen 5 5600G cada fragmento tarda 370 ms en CPU.' })
    expect(again.created).toBe(false)
    expect(again.message).toContain(first.path)

    const updated = await kb.saveKnowledge({ title: 'Tiempos de bge-m3', content: 'Ahora 300 ms.', path: first.path })
    expect(updated.created).toBe(false)
    expect((await kb.read(first.path)).content).toContain('Ahora 300 ms.')
    await expect(kb.saveKnowledge({ title: 'x', content: 'pisar nota del usuario', path: 'Mias/Idea.md' })).rejects.toThrow(/is a user note/)

    expect((await kb.overview()).notes.map((n) => n.path)).toEqual([first.path])
  })

  it('confines every path to the vault and never touches hidden folders', async () => {
    const { kb, root, trashed } = await openVault({ 'nota.md': 'hola' })
    await expect(kb.read('../fuera.md')).rejects.toThrow(/outside the working folder/)
    await expect(kb.write('..\\..\\fuera.md', 'x')).rejects.toThrow(/outside the working folder/)
    await expect(kb.create('.interna/x.md', 'file')).rejects.toThrow(/internal folder/)
    await expect(kb.delete('.')).rejects.toThrow(/whole vault/)
    await kb.delete('nota.md')
    expect(trashed).toEqual([join(root, 'nota.md')])
    expect(existsSync(join(root, 'nota.md'))).toBe(false)
    expect(kb.status().files).toBe(0)
  })
  it('AC-7.4 (028) readBytes refuses .., an absolute path, a dot segment and a junction that leaves the vault', async () => {
    const { kb, root } = await openVault({ 'Notas/a.png': 'PNGDATA', '.interna/s.md': 'secreto' })
    const outside = mkdtempSync(join(tmpdir(), 'alma-outside-'))
    dirs.push(outside)
    writeFileSync(join(outside, 'secret.md'), 'fuera')
    symlinkSync(outside, join(root, 'enlace'), 'junction')
    expect(new TextDecoder().decode((await kb.readBytes('Notas/a.png', 100)).bytes)).toBe('PNGDATA')
    const refusal = async (path: string): Promise<string | undefined> =>
      kb.readBytes(path, 100).then(
        () => undefined,
        (error: unknown) => (error instanceof ToolError ? error.text.key : String(error))
      )
    expect(await refusal('../fuera.md')).toBe('tool.cwd.outside')
    expect(await refusal(join(outside, 'secret.md'))).toBe('tool.cwd.outside')
    expect(await refusal('.interna/s.md')).toBe('tool.kb.hidden')
    expect(await refusal('enlace/secret.md')).toBe('tool.cwd.outside')
  })

  it('AC-7.4 (028) readBytes refuses a file over maxBytes and a folder', async () => {
    const { kb } = await openVault({ 'Notas/a.png': 'x'.repeat(100) })
    expect((await kb.readBytes('Notas/a.png', 100)).bytes).toHaveLength(100)
    await expect(kb.readBytes('Notas/a.png', 99)).rejects.toMatchObject({ text: { key: 'tool.kb.tooBig' } })
    await expect(kb.readBytes('Notas', 100)).rejects.toMatchObject({ text: { key: 'tool.kb.noNote' } })
  })
})
