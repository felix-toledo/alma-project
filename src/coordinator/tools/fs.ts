import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as z from 'zod/v4'
import { compareText } from '../../shared/i18n/format'
import { displayPath, resolveInWorkspace } from './paths'
import { defineTool, languageOf, ToolError, toolText, truncateMiddle } from './types'

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.next', '__pycache__', '.venv'])
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_FILE_BYTES = 1024 * 1024

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}

async function readText(path: string, label: string): Promise<string> {
  const info = await stat(path).catch(() => null)
  if (!info) throw new ToolError('tool.fs.notFound', { path: label })
  if (info.isDirectory()) throw new ToolError('tool.fs.isFolder', { path: label })
  if (info.size > MAX_READ_BYTES) throw new ToolError('tool.fs.tooBig', { path: label, bytes: info.size })
  const buffer = await readFile(path)
  if (looksBinary(buffer)) throw new ToolError('tool.fs.binary', { path: label })
  return buffer.toString('utf8')
}

/** Converts a simple glob (`*.ts`, `src/**\/*.tsx`) to a RegExp over forward-slash relative paths. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*' && glob[i + 1] === '*') {
      source += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'i')
}

async function* walk(dir: string, signal: AbortSignal): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (signal.aborted) return
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(full, signal)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

export const readFileTool = defineTool({
  name: 'read_file',
  description:
    'Reads a text file from the working folder and returns its numbered lines. Use it before editing a file or to answer questions about its content. For long files, ask for a range with offset and limit.',
  risk: 'read',
  schema: z.object({
    path: z.string().describe('Path relative to the working folder'),
    offset: z.number().int().min(1).optional().describe('First line to read (1 = start)'),
    limit: z.number().int().min(1).max(5000).optional().describe('Number of lines (default 2000)')
  }),
  async run({ path, offset = 1, limit = 2000 }, ctx) {
    const target = resolveInWorkspace(ctx.workspace, path)
    const lines = (await readText(target, path)).split(/\r?\n/)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const width = String(offset + slice.length).length
    const body = slice.map((line, i) => `${String(offset + i).padStart(width)}\t${line}`).join('\n')
    if (offset - 1 + slice.length >= lines.length) return truncateMiddle(body)
    return truncateMiddle(toolText(ctx, 'tool.fs.moreLines', { data: body, total: lines.length }))
  }
})

export const listDirTool = defineTool({
  name: 'list_dir',
  description:
    'Lists the contents of a folder inside the working folder (folders end with /). Use it to get your bearings before reading or searching files.',
  risk: 'read',
  schema: z.object({
    path: z.string().optional().describe('Relative path; defaults to the root of the working folder'),
    depth: z.number().int().min(1).max(4).optional().describe('Levels to walk (default 1)')
  }),
  async run({ path = '.', depth = 1 }, ctx) {
    const root = resolveInWorkspace(ctx.workspace, path)
    const lines: string[] = []
    const compare = compareText(languageOf(ctx))
    const visit = async (dir: string, level: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
        throw new ToolError('tool.fs.cannotList', { path: displayPath(ctx.workspace, dir) })
      })
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || compare(a.name, b.name))
      for (const entry of entries) {
        if (lines.length >= 1000) return
        const indent = '  '.repeat(level)
        if (entry.isDirectory()) {
          lines.push(`${indent}${entry.name}/`)
          if (level + 1 < depth && !SKIPPED_DIRS.has(entry.name)) await visit(join(dir, entry.name), level + 1)
        } else {
          lines.push(`${indent}${entry.name}`)
        }
      }
    }
    await visit(root, 0)
    if (lines.length === 0) return toolText(ctx, 'tool.fs.emptyFolder')
    if (lines.length >= 1000) return toolText(ctx, 'tool.fs.listTruncated', { data: lines.join('\n') })
    return lines.join('\n')
  }
})

export const searchFilesTool = defineTool({
  name: 'search_files',
  description:
    'Searches the text files in the working folder for a regular expression and returns path:line: text. Use it to find where something is defined or used. Skips node_modules, .git and build folders.',
  risk: 'read',
  schema: z.object({
    pattern: z.string().describe('Regular expression (JavaScript syntax)'),
    path: z.string().optional().describe('Subfolder to search in'),
    glob: z.string().optional().describe('File filter, e.g. "*.ts" or "src/**/*.tsx"'),
    case_sensitive: z.boolean().optional()
  }),
  async run({ pattern, path = '.', glob, case_sensitive = false }, ctx) {
    let regex: RegExp
    try {
      regex = new RegExp(pattern, case_sensitive ? '' : 'i')
    } catch (error) {
      throw new ToolError('tool.fs.badRegex', { error: (error as Error).message })
    }
    const root = resolveInWorkspace(ctx.workspace, path)
    const filter = glob ? globToRegExp(glob) : null
    const matches: string[] = []
    for await (const file of walk(root, ctx.signal)) {
      const rel = displayPath(ctx.workspace, file)
      if (filter && !filter.test(rel) && !filter.test(rel.split('/').pop()!)) continue
      const info = await stat(file).catch(() => null)
      if (!info || info.size > MAX_SEARCH_FILE_BYTES) continue
      const buffer = await readFile(file).catch(() => null)
      if (!buffer || looksBinary(buffer)) continue
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
          if (matches.length >= 300) return toolText(ctx, 'tool.fs.tooManyMatches', { data: matches.join('\n') })
        }
      }
    }
    return matches.length ? matches.join('\n') : toolText(ctx, 'tool.fs.noMatches')
  }
})

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Creates a file or replaces it entirely with the given content (creates any missing folders). To change part of an existing file use edit_file.',
  risk: 'write',
  schema: z.object({
    path: z.string().describe('Path relative to the working folder'),
    content: z.string().describe('Full content of the file')
  }),
  async run({ path, content }, ctx) {
    const target = resolveInWorkspace(ctx.workspace, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    return toolText(ctx, 'tool.fs.written', { path: displayPath(ctx.workspace, target), bytes: Buffer.byteLength(content) })
  }
})

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Replaces an exact fragment of an existing file. old_string must appear exactly once (include enough context) unless you use replace_all. Read the file before editing it.',
  risk: 'write',
  schema: z.object({
    path: z.string(),
    old_string: z.string().min(1).describe('Exact text to replace'),
    new_string: z.string().describe('New text'),
    replace_all: z.boolean().optional()
  }),
  async run({ path, old_string, new_string, replace_all = false }, ctx) {
    const target = resolveInWorkspace(ctx.workspace, path)
    const original = await readText(target, path)
    const count = original.split(old_string).length - 1
    if (count === 0) throw new ToolError('tool.fs.oldNotFound')
    if (count > 1 && !replace_all) {
      throw new ToolError('tool.fs.oldAmbiguous', { count })
    }
    const updated = replace_all ? original.split(old_string).join(new_string) : original.replace(old_string, () => new_string)
    await writeFile(target, updated, 'utf8')
    return toolText(ctx, 'tool.fs.edited', { path: displayPath(ctx.workspace, target), count: replace_all ? count : 1 })
  }
})
