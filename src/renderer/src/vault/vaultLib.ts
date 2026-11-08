import { compareText } from '../../../shared/i18n/format'
import type { Language } from '../../../shared/i18n/language'
import type { VaultEntry } from '../../../shared/types'
import { baseName, parentOf, resolveVaultAsset } from '../../../shared/vault/paths'

// The pure path and name rules live in shared/vault so the phone's Notes use the very same ones.
export { baseName, fuzzyScore, IMAGE_EXT, join, noteName, parentOf } from '../../../shared/vault/paths'

export interface TreeNode {
  name: string
  path: string
  kind: 'file' | 'folder'
  children: TreeNode[]
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
export function buildTree(entries: VaultEntry[], language: Language): TreeNode[] {
  const root: TreeNode = { name: '', path: '', kind: 'folder', children: [] }
  const folders = new Map<string, TreeNode>([['', root]])
  const sorted = [...entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length)
  for (const entry of sorted) {
    const node: TreeNode = { name: baseName(entry.path), path: entry.path, kind: entry.kind, children: [] }
    const parent = folders.get(parentOf(entry.path)) ?? root
    parent.children.push(node)
    if (entry.kind === 'folder') folders.set(entry.path, node)
  }
  const compare = compareText(language)
  const sort = (node: TreeNode): void => {
    node.children.sort((a, b) => (a.kind === b.kind ? compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1))
    node.children.forEach(sort)
  }
  sort(root)
  return root.children
}

/** The URL for an image reference written in `notePath`: remote ones pass through, vault ones resolve as on the phone (shared rule). */
export function resolveAsset(target: string, notePath: string, entries: VaultEntry[]): string | null {
  if (/^https?:\/\//.test(target)) return target
  const path = resolveVaultAsset(target, notePath, entries)
  return path === null ? null : assetUrl(path)
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
