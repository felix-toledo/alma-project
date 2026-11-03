import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as z from 'zod/v4'
import { displayPath, resolveInWorkspace } from './paths'
import { defineTool, ToolError, truncateMiddle } from './types'

const SKIPPED_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.next', '__pycache__', '.venv'])
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_SEARCH_FILE_BYTES = 1024 * 1024

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}

async function readText(path: string, label: string): Promise<string> {
  const info = await stat(path).catch(() => null)
  if (!info) throw new ToolError(`No existe: ${label}`)
  if (info.isDirectory()) throw new ToolError(`${label} es una carpeta; usá list_dir.`)
  if (info.size > MAX_READ_BYTES) throw new ToolError(`${label} pesa ${info.size} bytes; es demasiado grande para leerlo entero.`)
  const buffer = await readFile(path)
  if (looksBinary(buffer)) throw new ToolError(`${label} parece un archivo binario.`)
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
    'Lee un archivo de texto de la carpeta de trabajo y devuelve sus líneas numeradas. Usalo antes de editar un archivo o para responder preguntas sobre su contenido. Para archivos largos, pedí un rango con offset y limit.',
  risk: 'read',
  schema: z.object({
    path: z.string().describe('Ruta relativa a la carpeta de trabajo'),
    offset: z.number().int().min(1).optional().describe('Primera línea a leer (1 = inicio)'),
    limit: z.number().int().min(1).max(5000).optional().describe('Cantidad de líneas (por defecto 2000)')
  }),
  async run({ path, offset = 1, limit = 2000 }, ctx) {
    const target = resolveInWorkspace(ctx.workspace, path)
    const lines = (await readText(target, path)).split(/\r?\n/)
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const width = String(offset + slice.length).length
    const body = slice.map((line, i) => `${String(offset + i).padStart(width)}\t${line}`).join('\n')
    const more = offset - 1 + slice.length < lines.length ? `\n… (${lines.length} líneas en total)` : ''
    return truncateMiddle(body + more)
  }
})

export const listDirTool = defineTool({
  name: 'list_dir',
  description:
    'Lista el contenido de una carpeta dentro de la carpeta de trabajo (las carpetas terminan en /). Usalo para orientarte antes de leer o buscar archivos.',
  risk: 'read',
  schema: z.object({
    path: z.string().optional().describe('Ruta relativa; por defecto la raíz de la carpeta de trabajo'),
    depth: z.number().int().min(1).max(4).optional().describe('Niveles a recorrer (por defecto 1)')
  }),
  async run({ path = '.', depth = 1 }, ctx) {
    const root = resolveInWorkspace(ctx.workspace, path)
    const lines: string[] = []
    const visit = async (dir: string, level: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => {
        throw new ToolError(`No se puede listar ${displayPath(ctx.workspace, dir)}`)
      })
      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
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
    if (lines.length === 0) return '(carpeta vacía)'
    return lines.join('\n') + (lines.length >= 1000 ? '\n… (listado truncado)' : '')
  }
})

export const searchFilesTool = defineTool({
  name: 'search_files',
  description:
    'Busca una expresión regular en los archivos de texto de la carpeta de trabajo y devuelve ruta:línea: texto. Usalo para encontrar dónde se define o usa algo. Ignora node_modules, .git y carpetas de build.',
  risk: 'read',
  schema: z.object({
    pattern: z.string().describe('Expresión regular (sintaxis de JavaScript)'),
    path: z.string().optional().describe('Subcarpeta donde buscar'),
    glob: z.string().optional().describe('Filtro de archivos, p. ej. "*.ts" o "src/**/*.tsx"'),
    case_sensitive: z.boolean().optional()
  }),
  async run({ pattern, path = '.', glob, case_sensitive = false }, ctx) {
    let regex: RegExp
    try {
      regex = new RegExp(pattern, case_sensitive ? '' : 'i')
    } catch (error) {
      throw new ToolError(`Expresión regular inválida: ${(error as Error).message}`)
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
          if (matches.length >= 300) return matches.join('\n') + '\n… (más de 300 coincidencias; afiná la búsqueda)'
        }
      }
    }
    return matches.length ? matches.join('\n') : 'Sin coincidencias.'
  }
})

export const writeFileTool = defineTool({
  name: 'write_file',
  description:
    'Crea un archivo o lo reemplaza completo con el contenido indicado (crea las carpetas que falten). Para cambiar una parte de un archivo existente usá edit_file.',
  risk: 'write',
  schema: z.object({
    path: z.string().describe('Ruta relativa a la carpeta de trabajo'),
    content: z.string().describe('Contenido completo del archivo')
  }),
  async run({ path, content }, ctx) {
    const target = resolveInWorkspace(ctx.workspace, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    return `Escrito ${displayPath(ctx.workspace, target)} (${Buffer.byteLength(content)} bytes).`
  }
})

export const editFileTool = defineTool({
  name: 'edit_file',
  description:
    'Reemplaza un fragmento exacto de un archivo existente. old_string debe aparecer una sola vez (incluí contexto suficiente) salvo que uses replace_all. Leé el archivo antes de editarlo.',
  risk: 'write',
  schema: z.object({
    path: z.string(),
    old_string: z.string().min(1).describe('Texto exacto a reemplazar'),
    new_string: z.string().describe('Texto nuevo'),
    replace_all: z.boolean().optional()
  }),
  async run({ path, old_string, new_string, replace_all = false }, ctx) {
    const target = resolveInWorkspace(ctx.workspace, path)
    const original = await readText(target, path)
    const count = original.split(old_string).length - 1
    if (count === 0) throw new ToolError('old_string no aparece en el archivo. Volvé a leerlo y copiá el texto exacto.')
    if (count > 1 && !replace_all) {
      throw new ToolError(`old_string aparece ${count} veces. Agregá contexto para que sea único o usá replace_all.`)
    }
    const updated = replace_all ? original.split(old_string).join(new_string) : original.replace(old_string, () => new_string)
    await writeFile(target, updated, 'utf8')
    return `Editado ${displayPath(ctx.workspace, target)} (${replace_all ? count : 1} reemplazo${count > 1 && replace_all ? 's' : ''}).`
  }
})
