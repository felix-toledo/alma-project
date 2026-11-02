import type { VaultEntry } from '../../../shared/types'

export interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'folder'
  children: TreeNode[]
}

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i

export function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/')
}

export function noteName(path: string): string {
  return baseName(path).replace(/\.(md|excalidraw)$/i, '')
}

/** URL the renderer can load for a vault file; served by the main process, confined to the active vault. */
export function assetUrl(path: string): string {
  return `alma-vault://file/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** The vault path behind an assetUrl. */
export function vaultPathOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''))
}

/** Folders first, then files, both alphabetically (like a file explorer). */
export function buildTree(entries: VaultEntry[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] }
  const folders = new Map<string, TreeNode>([['', root]])
  const sorted = [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length)
  for (const entry of sorted) {
    const node: TreeNode = { name: baseName(entry.path), path: entry.path, kind: entry.kind, children: [] }
    const parent = folders.get(parentOf(entry.path)) ?? root
    parent.children.push(node)
    if (entry.kind === 'folder') folders.set(entry.path, node)
  }
  const sort = (node: TreeNode): void => {
    node.children.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'es', { numeric: true }) : a.kind === 'folder' ? -1 : 1))
    node.children.forEach(sort)
  }
  sort(root)
  return root.children
}

/**
 * Subsequence match like a quick switcher: every query character must appear in order. Higher is better;
 * consecutive runs and matches at word starts score more, and the file name counts more than its folder.
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 1
  const t = text.toLowerCase()
  const nameStart = t.lastIndexOf('/') + 1
  let score = 0
  let ti = 0
  let run = 0
  for (const char of q) {
    const found = t.indexOf(char, ti)
    if (found < 0) return 0
    run = found === ti ? run + 1 : 1
    const wordStart = found === 0 || /[\s/_\-.]/.test(t[found - 1])
    score += run * 2 + (wordStart ? 6 : 0) + (found >= nameStart ? 3 : 0)
    ti = found + 1
  }
  return score - t.length * 0.05
}

/** Resolves an image reference written in `notePath` to a vault path: relative first, then by file name (wiki-style embeds). */
export function resolveAsset(target: string, notePath: string, entries: VaultEntry[]): string | null {
  if (/^https?:\/\//.test(target)) return target
  const files = entries.filter((e) => e.kind === 'file')
  const parts: string[] = []
  for (const part of join(parentOf(notePath), target).split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  const relative = parts.join('/')
  if (files.some((e) => e.path === relative)) return assetUrl(relative)
  if (files.some((e) => e.path === target)) return assetUrl(target)
  const wanted = baseName(target).toLowerCase()
  const byName = files.find((e) => baseName(e.path).toLowerCase() === wanted)
  return byName ? assetUrl(byName.path) : null
}

// Anything (a chat tool card, a search hit) can ask the app to show a note in the vault view.
const OPEN_NOTE = 'alma:open-note'

export function openNote(path: string, line?: number): void {
  window.dispatchEvent(new CustomEvent(OPEN_NOTE, { detail: { path, line } }))
}

export function onOpenNote(listener: (path: string, line?: number) => void): () => void {
  const handler = (event: Event): void => {
    const { path, line } = (event as CustomEvent<{ path: string; line?: number }>).detail
    listener(path, line)
  }
  window.addEventListener(OPEN_NOTE, handler)
  return () => window.removeEventListener(OPEN_NOTE, handler)
}
