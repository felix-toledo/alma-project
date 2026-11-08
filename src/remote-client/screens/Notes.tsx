// Notes from the phone: the vault's folders, a name filter and a note reader, read-only. Nothing is kept: every screen asks the PC
// again (BR-26), and where the person is lives in memory in the shell (lib/nav.ts).
import { ChevronRight, File, FileText, Folder, FolderOpen, Image as ImageIcon, Search, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { IMAGE_EXT } from '../../shared/vault/paths'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import type { NavAction, NotesPlace } from '../lib/nav'
import { findEvent, folderEvent, noteTitle, readEvent, type NoteRow, type RowsView } from '../lib/notes-view'
import type { Pwa } from '../usePwa'
import { BackHeader } from './BackHeader'
import { PwaHeader } from './Header'
import { NoteBody, NoteImage } from './NoteBody'
import { StateMessage, StateView } from './StateView'
import { useLoad } from './useLoad'

/** The name field waits for a pause in the typing: each search is a request and the PC allows 60 a minute. */
const TYPING_PAUSE_MS = 350

const ICONS: Record<NoteRow['kind'], LucideIcon> = { folder: Folder, note: FileText, image: ImageIcon, file: File }

type Props = { pwa: Pwa; language: PwaLanguage; go(action: NavAction): void }

function Rows({ view, onOpen, language }: { view: RowsView; onOpen(row: NoteRow): void; language: PwaLanguage }): React.JSX.Element {
  if (view.kind === 'none') return <StateMessage icon={FolderOpen} text={translatePwa(language, 'remote.pwa.vault.none')} />
  return (
    <ul className="pwa-list">
      {view.rows.map((row) => {
        const Icon = ICONS[row.kind]
        return (
          <li key={row.key}>
            <button type="button" onClick={() => onOpen(row)}>
              <Icon className="pwa-list-icon" size={20} strokeWidth={1.75} aria-hidden="true" />
              <span className="pwa-list-text">
                <span className="pwa-list-name">{row.label}</span>
                {row.sub && <span className="pwa-list-sub">{row.sub}</span>}
              </span>
              {row.kind === 'folder' && <ChevronRight className="pwa-list-more" size={20} strokeWidth={1.75} aria-hidden="true" />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function FolderList({ pwa, language, path, restore, onOpen }: { pwa: Pwa; language: PwaLanguage; path: string; restore: number; onOpen(row: NoteRow): void }): React.JSX.Element | null {
  const { state, reload } = useLoad<RowsView>(async () => folderEvent(await pwa.notes.list(path)), path)
  // Coming back up to a folder lands where the person left it.
  useEffect(() => {
    if (state.kind !== 'loading') window.scrollTo(0, restore)
  }, [state.kind, restore])
  return (
    <StateView state={state} language={language} empty="remote.pwa.folder.empty" onRetry={reload}>
      {(view) => <Rows view={view} onOpen={onOpen} language={language} />}
    </StateView>
  )
}

function Results({ pwa, language, query, onOpen }: { pwa: Pwa; language: PwaLanguage; query: string; onOpen(row: NoteRow): void }): React.JSX.Element | null {
  const { state, reload } = useLoad<RowsView>(async () => findEvent(await pwa.notes.find(query)), query)
  return (
    <StateView state={state} language={language} empty="remote.pwa.notes.noMatch" onRetry={reload}>
      {(view) => <Rows view={view} onOpen={onOpen} language={language} />}
    </StateView>
  )
}

function FolderView({ pwa, language, go, path, scrolls }: Props & { path: string; scrolls: Map<string, number> }): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const [query, setQuery] = useState('')
  const [paused, setPaused] = useState('')
  const typed = query.trim()
  useEffect(() => {
    const timer = setTimeout(() => setPaused(typed), typed ? TYPING_PAUSE_MS : 0)
    return () => clearTimeout(timer)
  }, [typed])

  const open = (row: NoteRow): void => {
    scrolls.set(path, window.scrollY)
    go(row.kind === 'folder' ? { type: 'openFolder', path: row.path } : { type: 'openNote', path: row.path })
  }
  const heading = noteTitle(path, 'folder')
  return (
    <main className="pwa">
      {path === '' ? (
        <PwaHeader language={language} title={t('remote.pwa.notes.title')} />
      ) : (
        <BackHeader language={language} title={heading.title} subtitle={heading.where || undefined} onBack={() => go({ type: 'back' })} />
      )}
      <label className="pwa-field">
        <Search size={20} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="search"
          value={query}
          placeholder={t('remote.pwa.notes.find')}
          aria-label={t('remote.pwa.notes.find')}
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      {paused ? (
        <Results key={paused} pwa={pwa} language={language} query={paused} onOpen={open} />
      ) : (
        <FolderList key={path} pwa={pwa} language={language} path={path} restore={scrolls.get(path) ?? 0} onOpen={open} />
      )}
    </main>
  )
}

function NoteText({ pwa, language, path, go }: Props & { path: string }): React.JSX.Element | null {
  const { state, reload } = useLoad(async () => readEvent(await pwa.notes.read(path)), path)
  return (
    <StateView state={state} language={language} empty="remote.pwa.note.unavailable" onRetry={reload}>
      {(note) => <NoteBody text={note.text} notePath={note.path} language={language} fetchImage={pwa.notes.image} onOpenNote={(target) => go({ type: 'openNote', path: target })} />}
    </StateView>
  )
}

function Reader({ pwa, language, go, path }: Props & { path: string }): React.JSX.Element {
  const heading = noteTitle(path)
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [path])
  return (
    <main className="pwa">
      <BackHeader language={language} title={heading.title} subtitle={heading.where || undefined} onBack={() => go({ type: 'back' })} />
      {IMAGE_EXT.test(path) ? (
        <div className="pwa-prose">
          <NoteImage target={path} from="" alt={heading.title} language={language} fetchImage={pwa.notes.image} />
        </div>
      ) : (
        <NoteText pwa={pwa} language={language} go={go} path={path} />
      )}
    </main>
  )
}

export function Notes({ pwa, language, place, go, scrolls }: Props & { place: NotesPlace; scrolls: Map<string, number> }): React.JSX.Element {
  return place.view === 'note' ? <Reader key={place.path} pwa={pwa} language={language} go={go} path={place.path} /> : <FolderView pwa={pwa} language={language} go={go} path={place.path} scrolls={scrolls} />
}
