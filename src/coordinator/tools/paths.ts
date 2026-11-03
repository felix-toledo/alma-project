import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { ToolError } from './types'

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Closest existing ancestor, canonicalized, so symlinked directories can't escape the workspace. */
function realpathOfExistingAncestor(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return resolve(realpathSync(current), relative(current, path))
}

/**
 * Resolves a model-supplied path against the workspace and rejects anything outside it.
 * Model output is untrusted: `..`, absolute paths elsewhere and symlinks are all checked.
 */
export function resolveInWorkspace(workspace: string, path: string): string {
  if (!workspace) throw new ToolError('No hay carpeta de trabajo seleccionada para esta conversación.')
  if (!existsSync(workspace)) throw new ToolError(`La carpeta de trabajo no existe: ${workspace}`)
  const root = realpathSync(workspace)
  const target = resolve(root, path || '.')
  if (!isInside(root, target) || !isInside(root, realpathOfExistingAncestor(target))) {
    throw new ToolError(`La ruta ${path} está fuera de la carpeta de trabajo.`)
  }
  return target
}

export function displayPath(workspace: string, absolute: string): string {
  const rel = relative(workspace, absolute)
  return (rel || '.').split(sep).join('/')
}
