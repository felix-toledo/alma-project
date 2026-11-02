import { FileText, FolderOpen, Plus, Search, Sparkles, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KnowledgeOverview, KnowledgeStatus, SearchHit, VaultEntry } from '../../../shared/types'
import { request } from '../lib/coordinator'
import { relativeTime } from '../lib/format'
import { Icon } from '../umbra/Icon'
import { fuzzyScore, noteName } from './vaultLib'

const MEMORY_FILE = 'Alma/Recuerdos.md'

/** Ctrl+O: jump to any note by typing part of its name. */
export function QuickSwitcher({ entries, onOpen, onClose }: { entries: VaultEntry[]; onOpen(path: string): void; onClose(): void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const results = useMemo(() => {
    const files = entries.filter((e) => e.kind === 'file')
    if (!query.trim()) return [...files].sort((a, b) => b.mtime - a.mtime).slice(0, 50)
    return files
      .map((file) => ({ file, score: fuzzyScore(query, file.path.replace(/\.md$/i, '')) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((r) => r.file)
  }, [entries, query])

  useEffect(() => setIndex(0), [query])

  const choose = (path?: string): void => {
    if (!path) return
    onOpen(path)
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal quick-switcher" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Abrir nota">
        <input
          autoFocus
          placeholder="Buscá una nota por nombre…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setIndex((i) => Math.min(i + 1, results.length - 1)))
            else if (e.key === 'ArrowUp') (e.preventDefault(), setIndex((i) => Math.max(i - 1, 0)))
            else if (e.key === 'Enter') choose(results[index]?.path)
            else if (e.key === 'Escape') onClose()
          }}
        />
        <div className="switcher-list" role="listbox">
          {results.map((file, i) => (
            <div
              key={file.path}
              role="option"
              aria-selected={i === index}
              className={`switcher-item${i === index ? ' active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(file.path)}
            >
              <span className="ellipsis">{noteName(file.path)}</span>
              <span className="muted small ellipsis">{file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''}</span>
            </div>
          ))}
          {results.length === 0 && <p className="muted small pad">No hay notas con ese nombre.</p>}
        </div>
      </div>
    </div>
  )
}

/** Full-text and semantic search across the vault (same hybrid search the agents use). */
export function SearchPanel({ entries, onOpen, onClose }: { entries: VaultEntry[]; onOpen(path: string, line?: number): void; onClose(): void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const seq = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      return
    }
    const id = ++seq.current
    const timer = setTimeout(() => {
      setBusy(true)
      request<SearchHit[]>({ method: 'vault.search', query: q, limit: 30 })
        .then((result) => id === seq.current && (setHits(result), setError('')))
        .catch((e: Error) => id === seq.current && setError(e.message))
        .finally(() => id === seq.current && setBusy(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  const byName = useMemo(() => {
    const q = query.trim()
    if (q.length < 2) return []
    return entries
      .filter((e) => e.kind === 'file')
      .map((file) => ({ file, score: fuzzyScore(q, file.path) }))
      .filter((r) => r.score > 8)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((r) => r.file)
  }, [entries, query])

  return (
    <section className="vault-panel">
      <header className="vault-panel-head">
        <h2><Icon icon={Search} size="sm" /> Buscar en el vault</h2>
        <button className="icon-button" title="Cerrar" onClick={onClose}><Icon icon={X} size="sm" /></button>
      </header>
      <input autoFocus className="search-input" placeholder="Palabras o una pregunta: «qué decidí sobre el viaje»…" value={query} onChange={(e) => setQuery(e.target.value)} />
      <p className="muted small">Combina coincidencias de palabras con búsqueda por significado (bge-m3).{busy && ' Buscando…'}</p>
      {error && <p className="text-danger small">{error}</p>}
      {byName.length > 0 && (
        <div className="search-group">
          <div className="detail-label">Por nombre</div>
          {byName.map((file) => (
            <button key={file.path} className="search-hit" onClick={() => onOpen(file.path)}>
              <strong>{noteName(file.path)}</strong>
              <span className="muted small">{file.path}</span>
            </button>
          ))}
        </div>
      )}
      <div className="search-group">
        {hits.length > 0 && <div className="detail-label">En el contenido</div>}
        {hits.map((hit, i) => (
          <button key={`${hit.path}:${hit.line}:${i}`} className="search-hit" onClick={() => onOpen(hit.path, hit.line)}>
            <span className="row space">
              <strong className="ellipsis">{noteName(hit.path)}{hit.heading ? ` › ${hit.heading}` : ''}</strong>
              {hit.similarity !== undefined && <span className="badge" title="Similitud semántica">{Math.round(hit.similarity * 100)}%</span>}
            </span>
            <span className="search-snippet">{hit.snippet}</span>
            <span className="muted small">{hit.path}:{hit.line}</span>
          </button>
        ))}
        {query.trim().length >= 2 && !busy && hits.length === 0 && byName.length === 0 && !error && <p className="muted small">Sin resultados.</p>}
      </div>
    </section>
  )
}

/** What Alma knows: the always-on memories and the notes it wrote. Everything is editable or removable. */
export function KnowledgePanel({ status, version, onOpen, onClose }: { status: KnowledgeStatus | null; version: number; onOpen(path: string): void; onClose(): void }): React.JSX.Element {
  const [overview, setOverview] = useState<KnowledgeOverview>({ memories: [], notes: [] })
  const [error, setError] = useState('')

  useEffect(() => {
    void request<KnowledgeOverview>({ method: 'knowledge.overview' }).then(setOverview).catch((e: Error) => setError(e.message))
  }, [version])

  const forget = (text: string): void => {
    request({ method: 'knowledge.forget', text })
      .then(() => setOverview((o) => ({ ...o, memories: o.memories.filter((m) => m !== text) })))
      .catch((e: Error) => setError(e.message))
  }

  const deleteNote = (path: string): void => {
    if (!confirm(`¿Mover «${noteName(path)}» a la papelera?`)) return
    request({ method: 'vault.delete', path })
      .then(() => setOverview((o) => ({ ...o, notes: o.notes.filter((n) => n.path !== path) })))
      .catch((e: Error) => setError(e.message))
  }

  const model = status?.model
  const modelText =
    model?.state === 'ready' ? 'listo' : model?.state === 'downloading' ? `descargando ${model.progress ?? 0}%` : model?.state === 'loading' ? 'cargando' : model?.state === 'error' ? `error: ${model.error}` : 'en espera'

  return (
    <section className="vault-panel">
      <header className="vault-panel-head">
        <h2><Icon icon={Sparkles} size="sm" /> Lo que sabe Alma</h2>
        <button className="icon-button" title="Cerrar" onClick={onClose}><Icon icon={X} size="sm" /></button>
      </header>
      {error && <p className="text-danger small">{error}</p>}

      <div className="card">
        <div className="row space">
          <h3>Recuerdos</h3>
          <button className="ghost small" onClick={() => onOpen(MEMORY_FILE)}>Editar Recuerdos.md</button>
        </div>
        <p className="muted small">Datos cortos sobre vos que van en todas las conversaciones. Alma los agrega con «remember»; podés borrarlos o editarlos.</p>
        {overview.memories.length === 0 && <p className="muted small">Todavía no recuerda nada.</p>}
        <ul className="memory-list">
          {overview.memories.map((memory) => (
            <li key={memory}>
              <span>{memory}</span>
              <button className="icon-button" title="Olvidar" onClick={() => forget(memory)}><Icon icon={Trash2} size={14} /></button>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <h3>Conocimientos ({overview.notes.length})</h3>
        <p className="muted small">Notas que escribió Alma en Alma/Conocimientos. Son markdown común: editalas, movelas o borralas.</p>
        {overview.notes.length === 0 && <p className="muted small">Todavía no guardó conocimientos.</p>}
        {overview.notes.map((note) => (
          <div key={note.path} className="knowledge-item">
            <button className="link ellipsis" onClick={() => onOpen(note.path)}>
              <Icon icon={FileText} size={14} /> {note.title}
            </button>
            <span className="muted small">{relativeTime(note.mtime)}</span>
            <button className="icon-button" title="Mover a la papelera" onClick={() => deleteNote(note.path)}><Icon icon={Trash2} size={14} /></button>
          </div>
        ))}
      </div>

      {status && (
        <div className="card small">
          <h3>Índice</h3>
          <div className="muted">
            {status.files} notas · {status.chunks} fragmentos · {status.pending > 0 ? `${status.pending} por embeber` : 'todo embebido'} · modelo bge-m3: {modelText}
          </div>
          <div className="muted ellipsis" title={status.vault}>{status.vault}</div>
        </div>
      )}
    </section>
  )
}

/** No vault yet: create the default one or open any folder (any folder of notes works as is). */
export function VaultWelcome({ onCreate, onOpenFolder }: { onCreate(): void; onOpenFolder(): void }): React.JSX.Element {
  const [defaultPath, setDefaultPath] = useState('')
  useEffect(() => void window.desktop.defaultVaultPath().then(setDefaultPath), [])
  return (
    <main className="empty-state">
      <h1>Tu vault</h1>
      <p>Una carpeta de notas en markdown que Alma lee, busca y completa con lo que aprende.</p>
      <button className="primary" onClick={onCreate}>
        <Icon icon={Plus} size="sm" /> Crear vault nuevo
      </button>
      <p className="hint small muted">{defaultPath}</p>
      <button className="ghost" onClick={onOpenFolder}>
        <Icon icon={FolderOpen} size="sm" /> Abrir una carpeta como vault
      </button>
    </main>
  )
}
