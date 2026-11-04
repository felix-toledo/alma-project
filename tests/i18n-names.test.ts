// Spec 025 phase F5: the names Alma writes to disk follow the language for NEW files; what already exists under either
// language's name wins and is never renamed or duplicated (BR-23, ADR 0019).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { libraryPath, loadLibrary } from '../src/coordinator/compose'
import { minutesPath } from '../src/coordinator/company/engine'
import { KnowledgeBase } from '../src/coordinator/knowledge/base'
import { splitFrontmatter } from '../src/coordinator/knowledge/markdown'
import { isOwnNote, newFileName, resolveName, welcomeNoteFile } from '../src/shared/i18n/names'
import type { Language } from '../src/shared/types'

const NAMES = { es: 'Recuerdos.md', en: 'Memories.md' }

describe('AC-9.3 resolveName', () => {
  const present = (...names: string[]) => (name: string) => names.includes(name)
  it('AC-9.3 uses the language name when neither exists, the one that exists otherwise, and the current one when both do', () => {
    expect(resolveName('es', NAMES, present())).toBe('Recuerdos.md')
    expect(resolveName('en', NAMES, present())).toBe('Memories.md')
    expect(resolveName('en', NAMES, present('Recuerdos.md'))).toBe('Recuerdos.md')
    expect(resolveName('es', NAMES, present('Memories.md'))).toBe('Memories.md')
    expect(resolveName('en', NAMES, present('Recuerdos.md', 'Memories.md'))).toBe('Memories.md')
    expect(resolveName('es', NAMES, present('Recuerdos.md', 'Memories.md'))).toBe('Recuerdos.md')
  })
})

describe('AC-9.4 isOwnNote', () => {
  it('AC-9.4 recognizes its own notes by the Spanish or the English frontmatter', () => {
    expect(isOwnNote({ origen: 'ia' })).toBe(true)
    expect(isOwnNote({ origin: 'ai' })).toBe(true)
    expect(isOwnNote({ origen: 'usuario' })).toBe(false)
    expect(isOwnNote({ origin: 'ia' })).toBe(false)
    expect(isOwnNote({})).toBe(false)
  })
})

describe('AC-9.3 knowledge base', () => {
  let dirs: string[] = []
  let bases: KnowledgeBase[] = []
  afterEach(async () => {
    await Promise.all(bases.map((b) => b.close()))
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs = []
    bases = []
  })

  async function open(language: Language, files: Record<string, string> = {}) {
    const root = mkdtempSync(join(tmpdir(), 'alma-names-'))
    const data = mkdtempSync(join(tmpdir(), 'alma-names-data-'))
    dirs.push(root, data)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    const embedder = { modelId: 'fake', state: () => ({ state: 'error' as const }), embed: async (texts: string[]) => texts.map(() => new Float32Array(1024)) }
    const kb = new KnowledgeBase({ root, dataDir: data, embedder, trash: async () => {}, onStatus: () => {}, onChanged: () => {}, language: () => language })
    bases.push(kb)
    return { kb, root, file: (path: string) => join(root, path) }
  }

  it('AC-9.3 creates the memory file and the knowledge note under the language name when none exists', async () => {
    const es = await open('es')
    await es.kb.remember('toma mate')
    expect(existsSync(es.file('Alma/Recuerdos.md'))).toBe(true)
    expect(existsSync(es.file('Alma/Memories.md'))).toBe(false)
    const esNote = await es.kb.saveKnowledge({ title: 'Idea', content: 'texto', threadId: 't1' })
    expect(esNote.path).toBe('Alma/Conocimientos/Idea.md')
    expect(splitFrontmatter(readFileSync(es.file(esNote.path), 'utf8')).data).toMatchObject({ origen: 'ia', tipo: 'conocimiento', conversacion: 't1' })

    const en = await open('en')
    await en.kb.remember('likes tea')
    expect(existsSync(en.file('Alma/Memories.md'))).toBe(true)
    expect(existsSync(en.file('Alma/Recuerdos.md'))).toBe(false)
    const enNote = await en.kb.saveKnowledge({ title: 'Idea', content: 'text', threadId: 't1' })
    expect(enNote.path).toBe('Alma/Knowledge/Idea.md')
    const data = splitFrontmatter(readFileSync(en.file(enNote.path), 'utf8')).data
    expect(data).toMatchObject({ origin: 'ai', type: 'knowledge', conversation: 't1' })
    expect(Object.keys(data)).toEqual(['origin', 'type', 'created', 'updated', 'conversation'])
    expect(await en.kb.memories()).toEqual(['likes tea'])
  })

  it('AC-9.3 keeps using what exists under the other language name, never renaming or duplicating it', async () => {
    const { kb, file } = await open('en', { 'Alma/Recuerdos.md': '# Recuerdos\n\n- toma mate\n', 'Alma/Conocimientos/Vieja.md': '---\norigen: ia\n---\n# Vieja\n\ntexto\n' })
    expect(await kb.memories()).toEqual(['toma mate'])
    await kb.remember('likes tea')
    expect(readFileSync(file('Alma/Recuerdos.md'), 'utf8')).toBe('# Recuerdos\n\n- toma mate\n- likes tea\n')
    expect(existsSync(file('Alma/Memories.md'))).toBe(false)
    const note = await kb.saveKnowledge({ title: 'Nueva', content: 'text' })
    expect(note.path).toBe('Alma/Conocimientos/Nueva.md')
    expect(existsSync(file('Alma/Knowledge'))).toBe(false)
    expect((await kb.overview()).memoryFile).toBe('Alma/Recuerdos.md')
  })

  it('AC-9.3 uses the current language name when both exist and leaves the other untouched', async () => {
    const spanish = '# Recuerdos\n\n- toma mate\n'
    const { kb, file } = await open('en', { 'Alma/Recuerdos.md': spanish, 'Alma/Memories.md': '# Memories\n\n- likes tea\n' })
    await kb.remember('uses vim')
    expect(readFileSync(file('Alma/Recuerdos.md'), 'utf8')).toBe(spanish)
    expect(await kb.memories()).toEqual(['likes tea', 'uses vim'])
  })

  it('AC-9.4 updates its own notes whichever language wrote them, bumping the key they already have, and refuses the user\'s', async () => {
    const stamp = '---\norigen: ia\ntipo: conocimiento\ncreado: a\nactualizado: a\n---\n# Vieja\n\ntexto\n'
    const english = '---\norigin: ai\ntype: knowledge\ncreated: a\nupdated: a\n---\n# Old\n\ntext\n'
    const { kb } = await open('en', { 'Alma/Conocimientos/Vieja.md': stamp, 'Alma/Knowledge/Old.md': english, 'Mias/Mia.md': '# Mia\n\ntexto\n' })
    await kb.saveKnowledge({ title: 'Vieja', content: 'nuevo', path: 'Alma/Conocimientos/Vieja.md' })
    expect(Object.keys(splitFrontmatter((await kb.read('Alma/Conocimientos/Vieja.md')).content).data)).toEqual(['origen', 'tipo', 'creado', 'actualizado'])
    expect(splitFrontmatter((await kb.read('Alma/Conocimientos/Vieja.md')).content).data.actualizado).not.toBe('a')
    await kb.saveKnowledge({ title: 'Old', content: 'new', path: 'Alma/Knowledge/Old.md' })
    expect(splitFrontmatter((await kb.read('Alma/Knowledge/Old.md')).content).data.updated).not.toBe('a')
    await expect(kb.saveKnowledge({ title: 'Mia', content: 'x', path: 'Mias/Mia.md' })).rejects.toThrow()
  })
})

describe('AC-9.3 library', () => {
  const PALETTE = (background: string) => JSON.stringify({ marca: { background } })
  let workspace: string
  afterEach(() => rmSync(workspace, { recursive: true, force: true }))
  const make = (files: Record<string, string>) => {
    workspace = mkdtempSync(join(tmpdir(), 'alma-library-'))
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(workspace, path, '..'), { recursive: true })
      writeFileSync(join(workspace, path), content)
    }
  }
  const colorOf = async (language: Language) => {
    const library = await loadLibrary(libraryPath(workspace, language), language)
    return library.palettes.get('marca')?.bg
  }

  it('AC-9.3 library finds the folder and its files under either language name', async () => {
    make({ 'biblioteca/paletas.json': PALETTE('#102030') })
    expect(libraryPath(workspace, 'en')).toBe(join(workspace, 'biblioteca'))
    expect(await colorOf('en')).toBe('#102030')
    rmSync(workspace, { recursive: true, force: true })
    make({ 'library/palettes.json': PALETTE('#203040') })
    expect(libraryPath(workspace, 'es')).toBe(join(workspace, 'library'))
    expect(await colorOf('es')).toBe('#203040')
    rmSync(workspace, { recursive: true, force: true })
    make({ 'library/paletas.json': PALETTE('#304050'), 'library/recipes.json': JSON.stringify({ anuncio: { template: 'anuncio' } }) })
    const library = await loadLibrary(libraryPath(workspace, 'es'), 'es')
    expect(library.palettes.get('marca')?.bg).toBe('#304050')
    expect(library.recipes.has('anuncio')).toBe(true)
  })

  it('AC-9.3 library takes the current language name when both exist and ignores the other', async () => {
    make({ 'biblioteca/paletas.json': PALETTE('#111111'), 'library/palettes.json': PALETTE('#222222'), 'library/paletas.json': PALETTE('#333333') })
    expect(libraryPath(workspace, 'en')).toBe(join(workspace, 'library'))
    expect(libraryPath(workspace, 'es')).toBe(join(workspace, 'biblioteca'))
    expect(await colorOf('en')).toBe('#222222')
    expect(readFileSync(join(workspace, 'library', 'paletas.json'), 'utf8')).toBe(PALETTE('#333333'))
  })

  it('AC-9.3 library names the folder after the language when there is none, and creates nothing', () => {
    make({})
    expect(libraryPath(workspace, 'en')).toBe(join(workspace, 'library'))
    expect(libraryPath(workspace, 'es')).toBe(join(workspace, 'biblioteca'))
    expect(existsSync(join(workspace, 'library'))).toBe(false)
  })
})

describe('AC-9.3 minutes', () => {
  const at = new Date(2025, 10, 4, 10, 0)
  it('AC-9.3 minutes go to the folder in use, or to the language folder when there is none', () => {
    expect(minutesPath('es', at, 'Plan: ventas/Q4', () => false)).toBe('Reuniones/2025-11-04 Plan- ventas-Q4.md')
    expect(minutesPath('en', at, 'Plan', () => false)).toBe('Meetings/2025-11-04 Plan.md')
    expect(minutesPath('en', at, 'Plan', (name) => name === 'Reuniones')).toBe('Reuniones/2025-11-04 Plan.md')
    expect(minutesPath('es', at, 'Plan', (name) => name === 'Meetings')).toBe('Meetings/2025-11-04 Plan.md')
    expect(minutesPath('en', at, 'Plan', () => true)).toBe('Meetings/2025-11-04 Plan.md')
  })

  it('AC-9.3 minutes a topic with line breaks or control characters still makes a valid Windows file name', () => {
    const name = minutesPath('es', at, 'Plan\r\nde\tventas\u0000\u001f', () => false)
    expect(name).toBe('Reuniones/2025-11-04 Plan--de-ventas--.md')
    expect(Array.from(name).some((c) => c.charCodeAt(0) < 32)).toBe(false)
  })
})

describe('AC-9.3 vault names', () => {
  it('AC-9.3 vault names follow the language for new notes, drawings and the welcome note, numbering the ones taken', () => {
    const none = (): boolean => false
    expect(newFileName('es', 'note', none)).toBe('Sin título.md')
    expect(newFileName('en', 'note', none)).toBe('Untitled.md')
    expect(newFileName('es', 'drawing', none)).toBe('Dibujo.excalidraw')
    expect(newFileName('en', 'drawing', none)).toBe('Drawing.excalidraw')
    expect(newFileName('en', 'note', (name) => ['Untitled.md', 'Untitled 2.md'].includes(name))).toBe('Untitled 3.md')
    // A file under the other language's name does not count: the new one takes the language's own name.
    expect(newFileName('en', 'note', (name) => name === 'Sin título.md')).toBe('Untitled.md')
    expect(welcomeNoteFile('es')).toBe('Bienvenida.md')
    expect(welcomeNoteFile('en')).toBe('Welcome.md')
  })
})
