import { ChevronDown, ChevronRight, FilePlus, FileText, Folder, FolderOpen, FolderPlus, Image as ImageIcon, MessageSquarePlus, Pencil, PenTool, Search, Shapes, Sparkles, Trash2, File } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { DRAWING_EXT } from '../../../shared/excalidraw'
import type { KnowledgeStatus, PublicSettings, VaultEntry } from '../../../shared/types'
import { request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'
import { baseName, buildTree, IMAGE_EXT, join, noteName, parentOf, type TreeNode } from './vaultLib'

interface Props {
  settings: PublicSettings
  entries: VaultEntry[]
  activePath: string | null
  status: KnowledgeStatus | null
  onOpen(path: string): void
  onRenamed(from: string, to: string): void
  onDeleted(path: string): void
  onSearch(): void
  onKnowledge(): void
  onNewDrawing(): void
  /** "Preguntarle a Alma" about a file (the chat panel opens with it attached). */
  onAsk(path: string): void
  onSwitchVault(path: string): void
  onCreateVault(): void
  onOpenFolder(): void
}

type Editing = { mode: 'rename'; path: string } | { mode: 'new-file' | 'new-folder'; parent: string }

const EXPANDED_KEY = 'alma.vault.expanded'

function loadExpanded(vault: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(`${EXPANDED_KEY}:${vault}`) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function VaultSidebar(props: Props): React.JSX.Element {
  const { settings, entries } = props
  const vault = settings.activeVault
  const tree = useMemo(() => buildTree(entries), [entries])
  const [expanded, setExpanded] = useState(() => loadExpanded(vault))
  const [editing, setEditing] = useState<Editing | null>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => setExpanded(loadExpanded(vault)), [vault])
  useEffect(() => {
    try {
      localStorage.setItem(`${EXPANDED_KEY}:${vault}`, JSON.stringify([...expanded]))
    } catch {
      // Expanded folders are a convenience; losing them is fine.
    }
  }, [expanded, vault])

  // Reveal the open note's folders.
  useEffect(() => {
    if (!props.activePath) return
    const parents: string[] = []
    for (let p = parentOf(props.activePath); p; p = parentOf(p)) parents.push(p)
    if (parents.some((p) => !expanded.has(p))) setExpanded((prev) => new Set([...prev, ...parents]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.activePath])

  const run = (work: Promise<unknown>): void => {
    setError('')
    work.catch((e: Error) => setError(e.message))
  }

  const toggle = (path: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const submit = (value: string): void => {
    const current = editing
    setEditing(null)
    const name = value.trim().replace(/[\\/:*?"<>|]/g, '-')
    if (!current || !name) return
    if (current.mode === 'rename') {
      // A name typed without extension keeps the file's own (.md, .excalidraw).
      const ext = /\.(md|excalidraw)$/i.exec(current.path)?.[0] ?? ''
      const target = join(parentOf(current.path), ext && !/\.[a-z0-9]+$/i.test(name) ? `${name}${ext}` : name)
      if (target === current.path) return
      run(request({ method: 'vault.rename', from: current.path, to: target }).then(() => props.onRenamed(current.path, target)))
    } else if (current.mode === 'new-file') {
      const path = join(current.parent, /\.md$/i.test(name) ? name : `${name}.md`)
      run(request({ method: 'vault.create', path, entry: 'file' }).then(() => props.onOpen(path)))
    } else {
      const path = join(current.parent, name)
      run(request({ method: 'vault.create', path, entry: 'folder' }).then(() => setExpanded((prev) => new Set([...prev, path]))))
    }
  }

  const move = (from: string, folder: string): void => {
    const to = join(folder, baseName(from))
    if (to === from || folder === from || folder.startsWith(`${from}/`)) return
    run(request({ method: 'vault.rename', from, to }).then(() => props.onRenamed(from, to)))
  }

  const remove = (node: TreeNode): void => {
    const what = node.kind === 'folder' ? `la carpeta «${node.name}» y todo su contenido` : `«${noteName(node.path)}»`
    if (!confirm(`¿Mover ${what} a la papelera?`)) return
    run(request({ method: 'vault.delete', path: node.path }).then(() => props.onDeleted(node.path)))
  }

  const startNew = (mode: 'new-file' | 'new-folder', parent: string): void => {
    if (parent) setExpanded((prev) => new Set([...prev, parent]))
    setEditing({ mode, parent })
  }

  const renderInput = (initial: string, depth: number, icon: typeof File): React.JSX.Element => (
    <div className="tree-row editing" style={{ paddingLeft: 10 + depth * 14 }}>
      <Icon icon={icon} size={16} />
      <input
        autoFocus
        defaultValue={initial}
        onFocus={(e) => e.currentTarget.setSelectionRange(0, initial.replace(/\.(md|excalidraw)$/i, '').length)}
        onBlur={(e) => submit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setEditing(null)
        }}
      />
    </div>
  )

  const renderNode = (node: TreeNode, depth: number): React.JSX.Element => {
    if (editing?.mode === 'rename' && editing.path === node.path) {
      return <div key={node.path}>{renderInput(node.kind === 'file' ? node.name : node.name, depth, node.kind === 'folder' ? Folder : FileText)}</div>
    }
    const isFolder = node.kind === 'folder'
    const open = expanded.has(node.path)
    const icon = isFolder
      ? open
        ? FolderOpen
        : Folder
      : IMAGE_EXT.test(node.name)
        ? ImageIcon
        : DRAWING_EXT.test(node.name)
          ? Shapes
          : node.name.toLowerCase().endsWith('.md')
            ? FileText
            : File
    return (
      <div key={node.path}>
        <div
          className={`tree-row${node.path === props.activePath ? ' active' : ''}${dropTarget === node.path ? ' drop' : ''}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          role="button"
          tabIndex={0}
          draggable
          onDragStart={(e) => e.dataTransfer.setData('text/x-alma-path', node.path)}
          onDragOver={(e) => {
            if (!isFolder) return
            e.preventDefault()
            setDropTarget(node.path)
          }}
          onDragLeave={() => setDropTarget((t) => (t === node.path ? null : t))}
          onDrop={(e) => {
            e.preventDefault()
            setDropTarget(null)
            const from = e.dataTransfer.getData('text/x-alma-path')
            if (from && isFolder) move(from, node.path)
          }}
          onClick={() => (isFolder ? toggle(node.path) : props.onOpen(node.path))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (isFolder ? toggle(node.path) : props.onOpen(node.path))
            if (e.key === 'F2') setEditing({ mode: 'rename', path: node.path })
            if (e.key === 'Delete') remove(node)
          }}
          title={node.path}
        >
          {isFolder ? <Icon icon={open ? ChevronDown : ChevronRight} size={14} /> : <span className="tree-spacer" />}
          <Icon icon={icon} size={16} />
          <span className="ellipsis">{isFolder ? node.name : noteName(node.path)}</span>
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            {isFolder && (
              <>
                <button className="icon-button" title="Nueva nota" onClick={() => startNew('new-file', node.path)}>
                  <Icon icon={FilePlus} size={14} />
                </button>
                <button className="icon-button" title="Nueva carpeta" onClick={() => startNew('new-folder', node.path)}>
                  <Icon icon={FolderPlus} size={14} />
                </button>
              </>
            )}
            {!isFolder && (
              <button className="icon-button" title="Preguntarle a Alma sobre este archivo" onClick={() => props.onAsk(node.path)}>
                <Icon icon={MessageSquarePlus} size={14} />
              </button>
            )}
            <button className="icon-button" title="Renombrar (F2)" onClick={() => setEditing({ mode: 'rename', path: node.path })}>
              <Icon icon={Pencil} size={14} />
            </button>
            <button className="icon-button" title="Mover a la papelera (Supr)" onClick={() => remove(node)}>
              <Icon icon={Trash2} size={14} />
            </button>
          </span>
        </div>
        {isFolder && open && (
          <>
            {editing && editing.mode !== 'rename' && editing.parent === node.path &&
              renderInput(editing.mode === 'new-file' ? 'Sin título' : 'Nueva carpeta', depth + 1, editing.mode === 'new-file' ? FileText : Folder)}
            {node.children.map((child) => renderNode(child, depth + 1))}
          </>
        )}
      </div>
    )
  }

  const pending = props.status?.pending ?? 0
  const model = props.status?.model

  return (
    <div className="vault-sidebar">
      <div className="vault-picker">
        <select
          value={vault}
          onChange={(e) => {
            const value = e.target.value
            if (value === '__new') props.onCreateVault()
            else if (value === '__open') props.onOpenFolder()
            else props.onSwitchVault(value)
          }}
          aria-label="Vault activo"
        >
          {settings.vaults.map((path) => (
            <option key={path} value={path} title={path}>
              {path.split(/[\\/]/).pop()}
            </option>
          ))}
          <option value="__new">＋ Crear vault nuevo (Documentos\Alma\Vault)</option>
          <option value="__open">Abrir carpeta como vault…</option>
        </select>
      </div>
      <div className="vault-toolbar">
        <button className="icon-button" title="Nueva nota (Ctrl+N)" onClick={() => startNew('new-file', '')}>
          <Icon icon={FilePlus} size={16} />
        </button>
        <button className="icon-button" title="Nueva carpeta" onClick={() => startNew('new-folder', '')}>
          <Icon icon={FolderPlus} size={16} />
        </button>
        <button className="icon-button" title="Nuevo dibujo (Excalidraw)" onClick={props.onNewDrawing}>
          <Icon icon={PenTool} size={16} />
        </button>
        <button className="icon-button" title="Buscar (Ctrl+Shift+F)" onClick={props.onSearch}>
          <Icon icon={Search} size={16} />
        </button>
        <button className="icon-button" title="Lo que sabe Alma" onClick={props.onKnowledge}>
          <Icon icon={Sparkles} size={16} />
        </button>
      </div>
      {error && <div className="text-danger small pad">{error}</div>}
      <nav
        className="vault-tree"
        aria-label="Archivos del vault"
        onDragOver={(e) => {
          e.preventDefault()
          setDropTarget('')
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDropTarget(null)
          const from = e.dataTransfer.getData('text/x-alma-path')
          if (from) move(from, '')
        }}
      >
        {editing && editing.mode !== 'rename' && editing.parent === '' &&
          renderInput(editing.mode === 'new-file' ? 'Sin título' : 'Nueva carpeta', 0, editing.mode === 'new-file' ? FileText : Folder)}
        {tree.map((node) => renderNode(node, 0))}
        {tree.length === 0 && !editing && <p className="muted small pad">El vault está vacío.</p>}
      </nav>
      <div className="vault-status small muted" aria-live="polite">
        {model?.state === 'downloading'
          ? `Descargando bge-m3… ${model.progress ?? 0}%`
          : model?.state === 'error'
            ? <span className="text-danger" title={model.error}>Búsqueda semántica no disponible</span>
            : pending > 0
              ? `Indexando: faltan ${pending} fragmentos`
              : props.status
                ? `${props.status.files} notas indexadas`
                : ''}
      </div>
    </div>
  )
}
