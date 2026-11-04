import { BookOpen, ExternalLink, MessageSquare, MessageSquarePlus, PencilLine, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { DRAWING_EXT } from '../../../shared/excalidraw'
import type { KnowledgeStatus, PublicSettings } from '../../../shared/types'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { Markdown } from '../components/Markdown'
import { useT } from '../i18n/useT'
import { fileAttachment, textAttachment, type Attachment } from '../lib/attachments'
import { Icon } from '../umbra/Icon'
import { NoteEditor } from './NoteEditor'
import { KnowledgePanel, QuickSwitcher, SearchPanel } from './panels'
import type { useVault } from './useVault'
import { assetUrl, IMAGE_EXT, noteName, resolveAsset } from './vaultLib'

export type VaultPanel = 'none' | 'search' | 'knowledge'

// Excalidraw is big: it loads the first time a drawing is opened.
const DrawingEditor = lazy(() => import('./DrawingEditor'))
const DocumentPreview = lazy(() => import('./DocumentPreview'))
const DOCUMENT_EXT = /\.(docx|xlsx|xlsm|csv|pptx|pdf)$/i

interface Props {
  settings: PublicSettings
  vault: ReturnType<typeof useVault>
  status: KnowledgeStatus | null
  version: number
  panel: VaultPanel
  onPanel(panel: VaultPanel): void
  /** Hands a selection or a file to the chat panel (and opens it). */
  onAsk(attachment: Attachment): void
  /** The chat panel on the right, when open. */
  chat?: React.ReactNode
  onToggleChat(): void
}

const READ_KEY = 'alma.vault.reading'

export function VaultView({ settings, vault, status, version, panel, onPanel, onAsk, chat, onToggleChat }: Props): React.JSX.Element {
  const t = useT()
  const { tabs, active, docs, entries } = vault
  const selection = useRef<{ text: string; lines: [number, number] } | null>(null)
  useEffect(() => {
    selection.current = null
  }, [active])
  const [switcher, setSwitcher] = useState(false)
  const [reading, setReading] = useState<boolean>(() => {
    try {
      return localStorage.getItem(READ_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(READ_KEY, reading ? '1' : '0')
    } catch {
      // ignore
    }
  }, [reading])

  /** The selected text (editor or reading view), or the whole note when nothing is selected. */
  const askAboutNote = (): void => {
    if (!active) return
    const picked = reading ? window.getSelection()?.toString().trim() : selection.current?.text
    if (picked) onAsk(textAttachment(active, picked, reading ? undefined : selection.current?.lines))
    else void fileAttachment(active).then(onAsk)
  }
  const askRef = useRef(askAboutNote)
  askRef.current = askAboutNote

  // Note shortcuts, where they don't clash with the chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key === 'o' && !e.shiftKey) (e.preventDefault(), setSwitcher(true))
      else if (key === 'f' && e.shiftKey) (e.preventDefault(), onPanel('search'))
      else if (key === 'n' && !e.shiftKey) (e.preventDefault(), void vault.createNote())
      else if (key === 'w' && active) (e.preventDefault(), vault.close(active))
      else if (key === 'e' && !e.shiftKey) (e.preventDefault(), setReading((r) => !r))
      // Like Cursor: Ctrl+L sends the selection to the chat.
      else if (key === 'l' && !e.shiftKey && active?.toLowerCase().endsWith('.md')) (e.preventDefault(), askRef.current())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, vault, onPanel])

  const doc = active ? docs[active] : undefined
  const absolute = active ? `${settings.activeVault}\\${active.split('/').join('\\')}` : ''

  const body = (): React.JSX.Element => {
    if (!active) {
      return (
        <div className="vault-empty muted">
          <p>{t('vault.openHint')}</p>
          <p className="small">{t('vault.shortcuts')}</p>
        </div>
      )
    }
    if (IMAGE_EXT.test(active)) {
      return (
        <div className="vault-image">
          <img src={assetUrl(active)} alt={noteName(active)} />
        </div>
      )
    }
    if (DRAWING_EXT.test(active)) {
      if (!doc || doc.loading) return <div className="vault-empty muted">{t('common.loading')}</div>
      return (
        <Suspense fallback={<div className="vault-empty muted">{t('vault.loadingExcalidraw')}</div>}>
          <DrawingEditor key={active} path={active} content={doc.content} onChange={(content) => vault.edit(active, content)} onAsk={onAsk} />
        </Suspense>
      )
    }
    if (DOCUMENT_EXT.test(active)) {
      return (
        <Suspense fallback={<div className="vault-empty muted">{t('vault.loadingPreview')}</div>}>
          <DocumentPreview key={active} path={active} url={assetUrl(active)} onOpen={() => void window.desktop.openPath(absolute)} />
        </Suspense>
      )
    }
    if (!active.toLowerCase().endsWith('.md')) {
      return (
        <div className="vault-empty muted">
          <p>{t('vault.notNote')}</p>
          <button className="ghost" onClick={() => void window.desktop.openPath(absolute)}>
            <Icon icon={ExternalLink} size="sm" /> {t('vault.openSystem')}
          </button>
        </div>
      )
    }
    if (!doc || doc.loading) return <div className="vault-empty muted">{t('common.loading')}</div>
    if (doc.error && !doc.disk && !doc.content) return <div className="vault-empty text-danger">{doc.error}</div>
    if (reading) {
      return (
        <div className="note-reading">
          <Markdown text={doc.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')} resolveImage={(src) => resolveAsset(src, active, entries)} />
        </div>
      )
    }
    return (
      <NoteEditor
        path={active}
        content={doc.content}
        entries={entries}
        jump={vault.jump}
        onChange={(content) => vault.edit(active, content)}
        onSave={() => void vault.save(active)}
        onSelection={(picked) => (selection.current = picked)}
      />
    )
  }

  return (
    <main className="vault-view">
      <div className="vault-main">
        <div className="vault-tabs" role="tablist">
          {tabs.map((path) => {
            const d = docs[path]
            const dirty = !!d && !d.loading && d.content !== d.disk
            return (
              <div
                key={path}
                role="tab"
                aria-selected={path === active}
                className={`vault-tab${path === active ? ' active' : ''}`}
                title={path}
                onClick={() => vault.setActive(path)}
                onAuxClick={(e) => e.button === 1 && vault.close(path)}
              >
                <span className="ellipsis">{noteName(path)}</span>
                {dirty && <span className="dot" title={t('vault.saving')} />}
                <button className="icon-button" title={t('vault.closeTab')} onClick={(e) => (e.stopPropagation(), vault.close(path))}>
                  <Icon icon={X} size={12} />
                </button>
              </div>
            )
          })}
          <span className="grow" />
          {active?.toLowerCase().endsWith('.md') && (
            <>
              <button className="ghost small" onClick={askAboutNote} title={t('vault.askTitle')}>
                <Icon icon={MessageSquarePlus} size={14} /> {t('vault.ask')}
              </button>
              <button className="ghost small" onClick={() => setReading(!reading)} title={t('vault.toggleTitle')}>
                <Icon icon={reading ? PencilLine : BookOpen} size={14} /> {reading ? t('routines.edit') : t('vault.read')}
              </button>
            </>
          )}
          <button className={`ghost small${chat ? ' active' : ''}`} onClick={onToggleChat} title={chat ? t('app.vaultChat.closeTitle') : t('vault.openChat')} aria-pressed={!!chat}>
            <Icon icon={MessageSquare} size={14} /> {t('sidebar.mode.chat')}
          </button>
        </div>
        {doc?.error && (doc.disk || doc.content) && <div className="error-banner small">{t('vault.saveFailed', { error: doc.error })}</div>}
        <div className="vault-body">
          <ErrorBoundary resetKey={active ?? ''}>{body()}</ErrorBoundary>
        </div>
      </div>

      {panel === 'search' && <SearchPanel entries={entries} onOpen={(path, line) => vault.open(path, line)} onClose={() => onPanel('none')} />}
      {panel === 'knowledge' && <KnowledgePanel status={status} version={version} onOpen={(path) => vault.open(path)} onClose={() => onPanel('none')} />}
      {chat}
      {switcher && <QuickSwitcher entries={entries} onOpen={(path) => vault.open(path)} onClose={() => setSwitcher(false)} />}
    </main>
  )
}
