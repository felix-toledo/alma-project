import { useCallback, useEffect, useRef, useState } from 'react'
import { DRAWING_EXT, emptyDrawing } from '../../../shared/excalidraw'
import { newFileName } from '../../../shared/i18n/names'
import type { VaultEntry } from '../../../shared/types'
import { useLanguage } from '../i18n/useT'
import { request } from '../lib/coordinator'
import { join, parentOf } from './vaultLib'

export interface OpenDoc {
  /** What the editor shows. */
  content: string
  /** Last content known to be on disk; differs from `content` while unsaved. */
  disk: string
  loading: boolean
  error?: string
}

const AUTOSAVE_MS = 700
const TABS_KEY = 'alma.vault.tabs'

function loadTabs(vault: string): { tabs: string[]; active: string | null } {
  try {
    const saved = JSON.parse(localStorage.getItem(`${TABS_KEY}:${vault}`) ?? 'null') as { tabs: string[]; active: string | null } | null
    if (saved && Array.isArray(saved.tabs)) return saved
  } catch {
    // Tabs are a convenience: start empty.
  }
  return { tabs: [], active: null }
}

/** Files the vault opens as text documents: notes and Excalidraw drawings. */
const isDocument = (path: string): boolean => path.toLowerCase().endsWith('.md') || DRAWING_EXT.test(path)

/** Tree, open tabs and their documents for the active vault. `version` bumps whenever the vault changes on disk. */
export function useVault(vault: string, version: number) {
  const language = useLanguage()
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [{ tabs, active }, setTabs] = useState(() => loadTabs(vault))
  const [docs, setDocs] = useState<Record<string, OpenDoc>>({})
  const [jump, setJump] = useState<{ line: number; nonce: number } | undefined>()
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const docsRef = useRef(docs)
  docsRef.current = docs

  const load = useCallback(async (path: string, force = false) => {
    if (!isDocument(path)) return
    const current = docsRef.current[path]
    if (current && !force) return
    if (!current) setDocs((d) => ({ ...d, [path]: { content: '', disk: '', loading: true } }))
    try {
      const { content } = await request<{ content: string }>({ method: 'vault.read', path })
      setDocs((d) => {
        const doc = d[path]
        // Unsaved edits win over a reload; the next save writes them.
        if (doc && !doc.loading && doc.content !== doc.disk) return d
        return { ...d, [path]: { content, disk: content, loading: false } }
      })
    } catch (error) {
      setDocs((d) => ({ ...d, [path]: { content: '', disk: '', loading: false, error: (error as Error).message } }))
    }
  }, [])

  // A different vault: its own tabs, fresh documents.
  useEffect(() => {
    setTabs(loadTabs(vault))
    setDocs({})
  }, [vault])

  useEffect(() => {
    try {
      localStorage.setItem(`${TABS_KEY}:${vault}`, JSON.stringify({ tabs, active }))
    } catch {
      // ignore
    }
  }, [vault, tabs, active])

  // Refresh the tree, and reload open notes that changed on disk (another app, an agent, another tab).
  useEffect(() => {
    if (!vault) {
      setEntries([])
      return
    }
    void request<VaultEntry[]>({ method: 'vault.tree' }).then(setEntries).catch(() => setEntries([]))
    for (const path of Object.keys(docsRef.current)) void load(path, true)
  }, [vault, version, load])

  useEffect(() => {
    if (active) void load(active)
  }, [active, load])

  const save = useCallback(async (path: string) => {
    clearTimeout(timers.current.get(path))
    timers.current.delete(path)
    const doc = docsRef.current[path]
    if (!doc || doc.loading || doc.content === doc.disk) return
    const snapshot = doc.content
    try {
      await request({ method: 'vault.write', path, content: snapshot })
      setDocs((d) => (d[path] ? { ...d, [path]: { ...d[path], disk: snapshot, error: undefined } } : d))
    } catch (error) {
      setDocs((d) => (d[path] ? { ...d, [path]: { ...d[path], error: (error as Error).message } } : d))
    }
  }, [])

  const edit = useCallback(
    (path: string, content: string) => {
      setDocs((d) => (d[path] ? { ...d, [path]: { ...d[path], content } } : d))
      clearTimeout(timers.current.get(path))
      timers.current.set(path, setTimeout(() => void save(path), AUTOSAVE_MS))
    },
    [save]
  )

  // Unsaved edits are flushed when the window goes away.
  useEffect(() => {
    const flush = (): void => {
      for (const path of timers.current.keys()) void save(path)
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [save])

  const open = useCallback((path: string, line?: number) => {
    setTabs(({ tabs }) => ({ tabs: tabs.includes(path) ? tabs : [...tabs, path], active: path }))
    if (line) setJump({ line, nonce: Date.now() })
  }, [])

  const close = useCallback(
    (path: string) => {
      void save(path)
      setTabs(({ tabs, active }) => {
        const index = tabs.indexOf(path)
        const next = tabs.filter((t) => t !== path)
        return { tabs: next, active: active === path ? (next[index] ?? next[index - 1] ?? null) : active }
      })
      setDocs(({ [path]: _closed, ...rest }) => rest)
    },
    [save]
  )

  /** Keeps tabs pointing at renamed files and folders. */
  const renamed = useCallback((from: string, to: string) => {
    const map = (path: string): string => (path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : path)
    setTabs(({ tabs, active }) => ({ tabs: tabs.map(map), active: active && map(active) }))
    setDocs((d) => Object.fromEntries(Object.entries(d).map(([path, doc]) => [map(path), doc])))
  }, [])

  const deleted = useCallback((path: string) => {
    const gone = (p: string): boolean => p === path || p.startsWith(`${path}/`)
    setTabs(({ tabs, active }) => {
      const next = tabs.filter((t) => !gone(t))
      return { tabs: next, active: active && gone(active) ? (next[next.length - 1] ?? null) : active }
    })
    setDocs((d) => Object.fromEntries(Object.entries(d).filter(([p]) => !gone(p))))
  }, [])

  /** "Untitled.md", "Untitled 2.md"… (in the app language) next to the open note or at the root. */
  const createNote = useCallback(async () => {
    const folder = active ? parentOf(active) : ''
    const taken = new Set(entries.map((e) => e.path.toLowerCase()))
    const path = join(folder, newFileName(language, 'note', (name) => taken.has(join(folder, name).toLowerCase())))
    await request({ method: 'vault.create', path, entry: 'file' })
    open(path)
  }, [active, entries, language, open])

  /** "Drawing.excalidraw", "Drawing 2.excalidraw"… (in the app language) next to the open file. */
  const createDrawing = useCallback(async () => {
    const folder = active ? parentOf(active) : ''
    const taken = new Set(entries.map((e) => e.path.toLowerCase()))
    const path = join(folder, newFileName(language, 'drawing', (name) => taken.has(join(folder, name).toLowerCase())))
    await request({ method: 'vault.write', path, content: JSON.stringify(emptyDrawing(), null, 2) })
    open(path)
  }, [active, entries, language, open])

  return { entries, tabs, active, docs, jump, open, close, edit, save, renamed, deleted, createNote, createDrawing, setActive: (path: string) => setTabs((t) => ({ ...t, active: path })) }
}
