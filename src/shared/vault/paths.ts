import { compareText } from '../i18n/format'
import type { Language } from '../i18n/language'
import type { NoteEntry } from '../remote/wire'
import type { VaultEntry } from '../types'

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

/**
 * The one spelling used to compare vault-relative paths: forward slashes, no empty or '.' segments, '..' resolved
 * lexically, lower case. Exclusions and requested paths both go through it, so a case or slash edit is the same entry.
 */
export function canonicalVaultPath(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return parts.join('/').toLowerCase()
}

/** An entry that is not blank but canonicalizes to the vault root ('/', '.') fails closed: it excludes everything (Q12). */
const namesRoot = (entry: string): boolean => entry.trim() !== '' && canonicalVaultPath(entry) === ''

export function excludesWholeVault(excluded: readonly string[]): boolean {
  return excluded.some(namesRoot)
}

/** Matched by canonical path, so every folder under an excluded one is excluded too. A blank entry excludes nothing. */
export function isExcluded(path: string, excluded: readonly string[]): boolean {
  const wanted = canonicalVaultPath(path)
  return excluded.some((entry) => {
    if (namesRoot(entry)) return true
    const folder = canonicalVaultPath(entry)
    return folder !== '' && (wanted === folder || wanted.startsWith(`${folder}/`))
  })
}

const segmentsOf = (path: string): string[] => path.replace(/\\/g, '/').split('/').filter(Boolean)

// Windows ignores trailing dots and spaces in a name, so 'Private./x.md' would open 'Private/x.md'; ':' is a drive or a data stream.
function plainSegment(segment: string): boolean {
  if (segment.startsWith('.') || /[. :]$/.test(segment) || segment.includes(':')) return false
  if (segment.toLowerCase() === 'node_modules') return false
  return ![...segment].some((char) => char.charCodeAt(0) < 32)
}

/**
 * Whether a phone may even ask for this vault-relative path: no hidden or dot segment, no node_modules, no '..',
 * not absolute and not on a drive, and not inside an excluded folder. The root ('') is reachable.
 */
export function isReachable(path: string, excluded: readonly string[]): boolean {
  if (path.startsWith('/') || path.startsWith('\\')) return false
  return segmentsOf(path).every(plainSegment) && !isExcluded(path, excluded)
}

/** The entries directly inside one folder, folders first, in the collation of the app language; nothing the phone may not reach. */
export function listFolder(entries: VaultEntry[], folder: string, excluded: readonly string[], language: Language): NoteEntry[] {
  const parent = segmentsOf(folder).join('/')
  if (!isReachable(parent, excluded)) return []
  const compare = compareText(language)
  return entries
    .filter((entry) => parentOf(entry.path) === parent && isReachable(entry.path, excluded))
    .map((entry) => ({ name: baseName(entry.path), kind: entry.kind, size: entry.size, mtime: entry.mtime }))
    .sort((a, b) => (a.kind === b.kind ? compare(a.name, b.name) : a.kind === 'folder' ? -1 : 1))
}

/**
 * The quick-switcher rule of the desktop (name only, never content) over the whole reachable vault: files, best match first,
 * at most `limit`. An empty query lists nothing.
 */
export function findByName(entries: VaultEntry[], query: string, excluded: readonly string[], limit = 50): { path: string; name: string }[] {
  if (!query.trim()) return []
  return entries
    .filter((entry) => entry.kind === 'file' && isReachable(entry.path, excluded))
    .map((entry) => ({ entry, score: fuzzyScore(query, entry.path.replace(/\.md$/i, '')) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => ({ path: entry.path, name: baseName(entry.path) }))
}

/**
 * A path written in the note at `notePath`, resolved lexically against that note's folder (case kept). `escapes` says it climbed
 * above the vault root; the path is then clamped to the root, which is what image lookup wants and a link must not accept.
 */
export function resolveRelative(target: string, notePath: string): { path: string; escapes: boolean } {
  const parts: string[] = []
  let escapes = false
  for (const part of join(parentOf(notePath), target).split('/')) {
    if (part === '..') {
      if (parts.pop() === undefined) escapes = true
    } else if (part && part !== '.') parts.push(part)
  }
  return { path: parts.join('/'), escapes }
}

/**
 * Resolves an image reference written in `notePath` to a vault path: relative first, then exact, then by file name (wiki-style embeds).
 * Given `excluded` (the phone), only files the phone may reach can be the answer; without it (the desktop) every file can.
 */
export function resolveVaultAsset(target: string, notePath: string, entries: VaultEntry[], excluded?: readonly string[]): string | null {
  if (/^https?:\/\//.test(target)) return null
  const files = entries.filter((e) => e.kind === 'file' && (!excluded || isReachable(e.path, excluded)))
  const relative = resolveRelative(target, notePath).path
  if (files.some((e) => e.path === relative)) return relative
  if (files.some((e) => e.path === target)) return target
  const wanted = baseName(target).toLowerCase()
  return files.find((e) => baseName(e.path).toLowerCase() === wanted)?.path ?? null
}

/** Exclusions whose folder is no longer in the vault (renamed or moved outside Alma). Its new location stays reachable. */
export function staleExclusions(excluded: readonly string[], entries: VaultEntry[]): string[] {
  const folders = new Set(entries.filter((entry) => entry.kind === 'folder').map((entry) => canonicalVaultPath(entry.path)))
  return excluded.filter((entry) => !namesRoot(entry) && !folders.has(canonicalVaultPath(entry)))
}

export interface ExclusionRow {
  path: string
  /** The list entry that is exactly this folder (null when none, e.g. covered only by a parent). */
  entry: string | null
  /** Excluded only because a parent (or the root) is. */
  inherited: boolean
  stale: boolean
  root: boolean
}

/** What the "excluded folders" editor lists: every folder of the vault, then the entries that point nowhere (stale) or at the root. */
export function exclusionRows(excluded: readonly string[], entries: VaultEntry[]): ExclusionRow[] {
  const folders = entries
    .filter((entry) => entry.kind === 'folder')
    .map((entry) => ({ path: entry.path, key: canonicalVaultPath(entry.path) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const rows = folders.map(({ path, key }): ExclusionRow => {
    const entry = excluded.find((item) => canonicalVaultPath(item) === key) ?? null
    return { path, entry, inherited: entry === null && isExcluded(path, excluded), stale: false, root: false }
  })
  const lost = excluded.filter(namesRoot).map((entry): ExclusionRow => ({ path: '/', entry, inherited: false, stale: false, root: true }))
  const stale = staleExclusions(excluded, entries).map((entry): ExclusionRow => ({ path: entry, entry, inherited: false, stale: true, root: false }))
  return [...rows, ...stale, ...lost]
}

/** The list after the person ticks (adds the folder unless already there) or unticks (drops every spelling of it) a row. */
export function toggleExclusion(excluded: readonly string[], path: string, on: boolean): string[] {
  const key = canonicalVaultPath(path)
  const present = excluded.some((entry) => canonicalVaultPath(entry) === key)
  if (on) return present ? [...excluded] : [...excluded, path]
  return excluded.filter((entry) => canonicalVaultPath(entry) !== key)
}

/** A folder renamed or moved inside Alma: its exclusion and every exclusion under it follow (prefix rewrite, case-insensitive). */
export function moveExclusions(excluded: readonly string[], from: string, to: string): string[] {
  const fromKey = canonicalVaultPath(from)
  if (!fromKey) return [...excluded]
  const depth = fromKey.split('/').length
  return excluded.map((entry) => {
    const key = canonicalVaultPath(entry)
    if (key !== fromKey && !key.startsWith(`${fromKey}/`)) return entry
    return [...segmentsOf(to), ...segmentsOf(entry).slice(depth)].join('/')
  })
}
