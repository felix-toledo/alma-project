import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { sanitizeFileName } from '../../shared/attach/names'
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
  if (!workspace) throw new ToolError('tool.cwd.none')
  if (!existsSync(workspace)) throw new ToolError('tool.cwd.missing', { path: workspace })
  const root = realpathSync(workspace)
  const target = resolve(root, path || '.')
  if (!isInside(root, target) || !isInside(root, realpathOfExistingAncestor(target))) {
    throw new ToolError('tool.cwd.outside', { path })
  }
  return target
}

export function displayPath(workspace: string, absolute: string): string {
  const rel = relative(workspace, absolute)
  return (rel || '.').split(sep).join('/')
}

/** Safe stored name for a picture the user sent: unsafe runs become `_`, the last 60 characters are kept. */
export function inboxFileName(name: string): string {
  return sanitizeFileName(name)
}
