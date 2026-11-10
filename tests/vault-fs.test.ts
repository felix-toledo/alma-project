import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { welcomeNoteFile } from '../src/shared/i18n/names'
import { folderHasFiles, initVault } from '../src/coordinator/vault-fs'

// Spec 029 — the disk side of a company's folder: what counts as occupied (BR-14) and what initVault does.
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alma-vault-fs-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('folderHasFiles', () => {
  it('AC-5.3 (029) a folder that does not exist counts as empty', async () => {
    expect(await folderHasFiles(join(dir, 'missing'))).toBe(false)
  })

  it('AC-5.3 (029) an empty folder is empty and one with a file is occupied', async () => {
    expect(await folderHasFiles(dir)).toBe(false)
    writeFileSync(join(dir, 'a.md'), 'x')
    expect(await folderHasFiles(dir)).toBe(true)
  })

  it('AC-5.3 (029) a path that cannot be read counts as occupied, not as empty', async () => {
    const file = join(dir, 'plain.txt')
    writeFileSync(file, 'x')
    expect(await folderHasFiles(file)).toBe(true)
  })
})

describe('initVault', () => {
  it('AC-3.6 (029) creates the folder, parents included, with a welcome note in the language asked', async () => {
    const path = join(dir, 'Empresas', 'Acme')
    await initVault(path, 'en')
    expect(readdirSync(path)).toEqual([welcomeNoteFile('en')])
    expect(readFileSync(join(path, welcomeNoteFile('en')), 'utf8')).toMatch(/^# Welcome/)
    const other = join(dir, 'Empresas', 'Beta')
    await initVault(other, 'es')
    expect(readFileSync(join(other, welcomeNoteFile('es')), 'utf8')).toMatch(/^# Bienvenida/)
  })

  it('AC-3.6 (029) leaves a folder with notes alone, and ignores hidden entries when deciding it is empty', async () => {
    const full = join(dir, 'full')
    mkdirSync(full)
    writeFileSync(join(full, 'mine.md'), 'x')
    await initVault(full, 'en')
    expect(readdirSync(full)).toEqual(['mine.md'])

    const hidden = join(dir, 'hidden')
    mkdirSync(join(hidden, '.obsidian'), { recursive: true })
    await initVault(hidden, 'en')
    expect(readdirSync(hidden).sort()).toEqual(['.obsidian', welcomeNoteFile('en')].sort())
  })

  it('AC-3.6 (029) a failure surfaces to the caller instead of being swallowed', async () => {
    const file = join(dir, 'plain.txt')
    writeFileSync(file, 'x')
    await expect(initVault(join(file, 'sub'), 'en')).rejects.toThrow()
    await expect(initVault(file, 'en')).rejects.toThrow()
  })
})
