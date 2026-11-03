import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { editFileTool, globToRegExp, listDirTool, readFileTool, searchFilesTool, writeFileTool } from '../src/coordinator/tools/fs'
import { resolveInWorkspace } from '../src/coordinator/tools/paths'
import { runCommandTool } from '../src/coordinator/tools/shell'
import { ToolError, truncateMiddle, type ToolContext } from '../src/coordinator/tools/types'

let workspace: string
let ctx: ToolContext

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'alma-tools-'))
  ctx = { workspace, signal: new AbortController().signal } as ToolContext
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

describe('resolveInWorkspace', () => {
  it('resolves relative paths inside the workspace', () => {
    expect(resolveInWorkspace(workspace, 'src/a.ts')).toBe(join(workspace, 'src', 'a.ts'))
  })

  it('rejects paths that escape the workspace', () => {
    expect(() => resolveInWorkspace(workspace, '../fuera.txt')).toThrow(ToolError)
    expect(() => resolveInWorkspace(workspace, join(tmpdir(), 'otro.txt'))).toThrow(/fuera de la carpeta/)
  })

  it('requires a workspace', () => {
    expect(() => resolveInWorkspace('', 'a.txt')).toThrow(/carpeta de trabajo/)
  })
})

describe('globToRegExp', () => {
  it('matches simple and recursive globs', () => {
    expect(globToRegExp('*.ts').test('index.ts')).toBe(true)
    expect(globToRegExp('*.ts').test('src/index.ts')).toBe(false)
    expect(globToRegExp('src/**/*.tsx').test('src/a/b/c.tsx')).toBe(true)
    expect(globToRegExp('src/**/*.tsx').test('src/c.tsx')).toBe(true)
    expect(globToRegExp('src/**/*.tsx').test('lib/c.tsx')).toBe(false)
  })
})

describe('file tools', () => {
  it('writes nested files and reads them back numbered', async () => {
    await writeFileTool.run({ path: 'a/b/nota.txt', content: 'uno\ndos\ntres' }, ctx)
    const out = await readFileTool.run({ path: 'a/b/nota.txt', offset: 2, limit: 1 }, ctx)
    expect(out).toContain('2\tdos')
    expect(out).not.toContain('uno')
    expect(out).toContain('3 líneas en total')
  })

  it('refuses to write outside the workspace', async () => {
    await expect(writeFileTool.run({ path: '../escape.txt', content: 'x' }, ctx)).rejects.toThrow(ToolError)
  })

  it('edits a unique fragment and rejects ambiguous ones', async () => {
    writeFileSync(join(workspace, 'f.txt'), 'hola mundo\nhola de nuevo\n')
    await expect(editFileTool.run({ path: 'f.txt', old_string: 'hola', new_string: 'chau' }, ctx)).rejects.toThrow(/2 veces/)
    await editFileTool.run({ path: 'f.txt', old_string: 'hola mundo', new_string: 'chau mundo' }, ctx)
    expect(readFileSync(join(workspace, 'f.txt'), 'utf8')).toBe('chau mundo\nhola de nuevo\n')
    await editFileTool.run({ path: 'f.txt', old_string: 'o', new_string: '0', replace_all: true }, ctx)
    expect(readFileSync(join(workspace, 'f.txt'), 'utf8')).toBe('chau mund0\nh0la de nuev0\n')
    await expect(editFileTool.run({ path: 'f.txt', old_string: 'zzz', new_string: 'y' }, ctx)).rejects.toThrow(/no aparece/)
  })

  it('does not treat $ in replacement text specially', async () => {
    writeFileSync(join(workspace, 'p.txt'), 'precio: X')
    await editFileTool.run({ path: 'p.txt', old_string: 'X', new_string: "$& $1 $'" }, ctx)
    expect(readFileSync(join(workspace, 'p.txt'), 'utf8')).toBe("precio: $& $1 $'")
  })

  it('searches text files and skips node_modules', async () => {
    mkdirSync(join(workspace, 'src'))
    mkdirSync(join(workspace, 'node_modules'))
    writeFileSync(join(workspace, 'src', 'a.ts'), 'const objetivo = 1\n')
    writeFileSync(join(workspace, 'node_modules', 'b.ts'), 'const objetivo = 2\n')
    const out = await searchFilesTool.run({ pattern: 'objetivo', glob: '*.ts' }, ctx)
    expect(out).toBe('src/a.ts:1: const objetivo = 1')
  })

  it('lists directories with folders first', async () => {
    mkdirSync(join(workspace, 'carpeta'))
    writeFileSync(join(workspace, 'archivo.txt'), '')
    expect(await listDirTool.run({}, ctx)).toBe('carpeta/\narchivo.txt')
  })
})

describe('run_command', () => {
  it('runs in the workspace and reports the exit code', async () => {
    const out = await runCommandTool.run({ command: 'echo hola-agente' }, ctx)
    expect(out).toContain('Código de salida: 0')
    expect(out).toContain('hola-agente')
  }, 30_000)

  it('stops commands that exceed the timeout', async () => {
    const command = process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20'
    const out = await runCommandTool.run({ command, timeout_seconds: 1 }, ctx)
    expect(out).toContain('tiempo agotado')
  }, 30_000)
})

describe('truncateMiddle', () => {
  it('keeps the start and the end', () => {
    const out = truncateMiddle('a'.repeat(50) + 'b'.repeat(50), 20)
    expect(out.startsWith('a'.repeat(10))).toBe(true)
    expect(out.endsWith('b'.repeat(10))).toBe(true)
    expect(out).toContain('80 caracteres omitidos')
  })
})
