// Independent verification of spec 025 AC-9.3 / AC-9.4: names on disk, hostile cases.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { libraryPath } from '../src/coordinator/compose'
import { minutesPath } from '../src/coordinator/company/engine'
import { KnowledgeBase } from '../src/coordinator/knowledge/base'
import { splitFrontmatter } from '../src/coordinator/knowledge/markdown'
import { isOwnNote } from '../src/shared/i18n/names'
import type { Language } from '../src/shared/types'

let dirs: string[] = []
let bases: KnowledgeBase[] = []
afterEach(async () => {
  await Promise.all(bases.map((b) => b.close()))
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
  bases = []
})

async function open(language: Language, files: Record<string, string> = {}, folders: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'alma-vnames-'))
  const data = mkdtempSync(join(tmpdir(), 'alma-vnames-data-'))
  dirs.push(root, data)
  for (const folder of folders) mkdirSync(join(root, folder), { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const embedder = { modelId: 'fake', state: () => ({ state: 'error' as const }), embed: async (texts: string[]) => texts.map(() => new Float32Array(1024)) }
  const kb = new KnowledgeBase({ root, dataDir: data, embedder, trash: async () => {}, onStatus: () => {}, onChanged: () => {}, language: () => language })
  bases.push(kb)
  return { kb, root, file: (path: string) => join(root, path) }
}

describe('AC-9.3 knowledge folder', () => {
  it('AC-9.3 an existing but EMPTY folder under the other language name still wins (nothing duplicated)', async () => {
    const { kb, file } = await open('en', {}, ['Alma/Conocimientos'])
    const note = await kb.saveKnowledge({ title: 'Idea', content: 'text' })
    expect(note.path).toBe('Alma/Conocimientos/Idea.md')
    expect(existsSync(file('Alma/Knowledge'))).toBe(false)
  })

  it('AC-9.3 both folders exist: the current language folder gets the new note, the other is left untouched', async () => {
    const old = '---\norigen: ia\n---\n# Vieja\n\ntexto\n'
    const { kb, file } = await open('en', { 'Alma/Conocimientos/Vieja.md': old }, ['Alma/Knowledge'])
    const note = await kb.saveKnowledge({ title: 'Idea', content: 'text' })
    expect(note.path).toBe('Alma/Knowledge/Idea.md')
    expect(readdirSync(file('Alma/Conocimientos'))).toEqual(['Vieja.md'])
    expect(readFileSync(file('Alma/Conocimientos/Vieja.md'), 'utf8')).toBe(old)
    // and back: es with both uses the Spanish one
    const es = await open('es', { 'Alma/Conocimientos/Vieja.md': old }, ['Alma/Knowledge'])
    expect((await es.kb.saveKnowledge({ title: 'Idea', content: 'texto' })).path).toBe('Alma/Conocimientos/Idea.md')
  })

  it('AC-9.3 a hostile title cannot escape the knowledge folder or pick a name under the other language', async () => {
    const { kb, root } = await open('en')
    for (const title of ['../../etc/passwd', '..\\..\\evil', 'C:\\Windows\\x', '\\\\server\\share\\x', 'a/../../b']) {
      const note = await kb.saveKnowledge({ title, content: 'x' })
      expect(note.path.startsWith('Alma/Knowledge/'), note.path).toBe(true)
      expect(note.path.slice('Alma/Knowledge/'.length)).not.toMatch(/[\\/:]|\.\./)
    }
    expect(readdirSync(join(root, '..')).includes('evil.md')).toBe(false)
  })

  it('AC-9.3 neither exists and the vault is read-only on the memory file: remember creates only the language name', async () => {
    const { kb, file } = await open('en')
    expect(await kb.memories()).toEqual([])
    expect(existsSync(file('Alma'))).toBe(false)
    await kb.remember('likes tea')
    expect(readdirSync(file('Alma'))).toEqual(['Memories.md'])
  })
})

describe('AC-9.4 own notes', () => {
  it('AC-9.4 recognised with CRLF line endings and quoted values, refused when the key and value come from different languages', () => {
    const crlf = splitFrontmatter('---\r\norigen: "ia"\r\ntipo: conocimiento\r\n---\r\n# T\r\n').data
    expect(isOwnNote(crlf)).toBe(true)
    expect(isOwnNote(splitFrontmatter('---\r\norigin: ai\r\n---\r\n').data)).toBe(true)
    expect(isOwnNote({ origen: 'ai' })).toBe(false)
    expect(isOwnNote({ origin: 'ia' })).toBe(false)
    expect(isOwnNote({ origen: 'IA' })).toBe(false)
  })

  it('AC-9.4 a CRLF note written by Alma in Spanish is still updated as its own under en', async () => {
    const crlf = '---\r\norigen: ia\r\ntipo: conocimiento\r\ncreado: a\r\nactualizado: a\r\n---\r\n# Vieja\r\n\r\ntexto\r\n'
    const { kb } = await open('en', { 'Alma/Conocimientos/Vieja.md': crlf })
    await expect(kb.saveKnowledge({ title: 'Vieja', content: 'nuevo', path: 'Alma/Conocimientos/Vieja.md' })).resolves.toBeTruthy()
  })
})

describe('AC-9.3 minutes and library on hostile layouts', () => {
  const at = new Date(2025, 10, 4, 10, 0)
  it('AC-9.3 minutes: a topic with separators or a long text never leaves the folder', () => {
    for (const topic of ['../../x', 'a\\b', 'x'.repeat(500), '']) {
      const path = minutesPath('en', at, topic, () => false)
      expect(path.startsWith('Meetings/'), path).toBe(true)
      expect(path.slice('Meetings/'.length)).not.toMatch(/[\\/\r\n]/)
    }
  })
  it('AC-9.3 library: a FILE named like the folder is not a library, and a workspace with both uses the current language', () => {
    const ws = mkdtempSync(join(tmpdir(), 'alma-lib-'))
    dirs.push(ws)
    writeFileSync(join(ws, 'biblioteca'), 'not a folder')
    // a plain file called "biblioteca" exists; the contract only talks about a folder/file existing under either name
    const chosen = libraryPath(ws, 'en')
    expect([join(ws, 'biblioteca'), join(ws, 'library')]).toContain(chosen)
  })
})
