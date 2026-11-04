import { useEffect, useRef, useState } from 'react'
import type { ApprovalMode, PendingApproval, PublicSettings, Thread } from '../../../shared/types'
import { PROVIDER_NAMES } from '../../../shared/defaults'
import { composeMessage, fileAttachment, type Attachment } from '../lib/attachments'
import { request } from '../lib/coordinator'
import { APPROVAL_MODES, folderName, threadTitle } from '../lib/format'
import type { Draft } from '../lib/state'
import { MessageList } from './MessageList'
import { ModelPicker } from './ModelPicker'
import { CornerDownLeft, Folder, ImageIcon, Paperclip, Square, X } from 'lucide-react'
import { Icon } from '../umbra/Icon'

interface Props {
  thread: Thread
  settings: PublicSettings
  drafts: Record<string, Draft>
  running: boolean
  approvals: PendingApproval[]
  error?: string
  onDismissError(): void
  onUpdateSettings(patch: Partial<PublicSettings>): Promise<void>
  onOpenSettings(): void
  /** Vault pieces to send along with the next message ("Preguntarle a Alma"). */
  attachments?: Attachment[]
  onAttach?(attachment: Attachment): void
  onRemoveAttachment?(id: string): void
  onClearAttachments?(): void
  /** Narrow layout for the panel next to the vault. */
  compact?: boolean
}

export function ChatView({ thread, settings, drafts, running, approvals, error, attachments = [], compact = false, ...props }: Props): React.JSX.Element {
  const [text, setText] = useState('')
  /** Pictures pasted or dropped into this chat: saved in the inbox and handed to the agent by path (look_at_image). */
  const [images, setImages] = useState<Attachment[]>([])
  const [editingTitle, setEditingTitle] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const agent = settings.agents.find((a) => a.id === thread.agentId)
  const mode = APPROVAL_MODES.find((m) => m.value === settings.approvalMode)

  // Follow new output unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  })

  const addImages = async (files: File[]): Promise<void> => {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      const name = file.name && file.name !== 'image.png' ? file.name : `imagen-${Date.now()}.png`
      const path = await request<string>({ method: 'files.saveImage', name, base64 })
      setImages((list) => [...list, { id: path, label: name, path, body: `Imagen adjunta (mirala con look_at_image): ${path}` }])
    }
  }

  const send = async (): Promise<void> => {
    const message = text.trim()
    if (!message || running) return
    setText('')
    stickToBottom.current = true
    try {
      await request({ method: 'chat.send', threadId: thread.id, text: composeMessage(message, [...attachments, ...images]) })
      props.onClearAttachments?.()
      setImages([])
    } catch (err) {
      setText(message)
      alert((err as Error).message)
    }
  }

  const pickWorkspace = async (): Promise<void> => {
    const folder = await window.desktop.pickFolder()
    if (!folder) return
    await request({ method: 'threads.update', threadId: thread.id, workspace: folder })
    if (!settings.defaultWorkspace) await props.onUpdateSettings({ defaultWorkspace: folder })
  }

  return (
    <main
      className={`chat${compact ? ' chat-compact' : ''}`}
      onDragOver={(e) => (e.dataTransfer.types.includes('Files') || (props.onAttach && e.dataTransfer.types.includes('text/x-alma-path'))) && e.preventDefault()}
      onDrop={(e) => {
        // A picture dragged in from the computer is saved for the agent to look at.
        const dropped = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
        if (dropped.length) {
          e.preventDefault()
          void addImages(dropped)
          return
        }
        // A file dragged from the vault tree becomes an attachment.
        const path = e.dataTransfer.getData('text/x-alma-path')
        if (!path || !props.onAttach) return
        e.preventDefault()
        void fileAttachment(path).then(props.onAttach)
      }}
    >
      <header className="chat-header">
        {editingTitle ? (
          <input
            className="title-input"
            autoFocus
            defaultValue={thread.title}
            onBlur={(e) => {
              setEditingTitle(false)
              void request({ method: 'threads.update', threadId: thread.id, title: e.target.value })
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <h2 className="ellipsis" onDoubleClick={() => setEditingTitle(true)} title="Doble clic para renombrar">
            {threadTitle(thread.title)}
          </h2>
        )}
        <div className="header-controls">
          <ModelPicker
            settings={settings}
            agent={agent}
            value={thread.model}
            disabled={running}
            onChange={(model) => void request({ method: 'threads.update', threadId: thread.id, model })}
          />
          <button
            className={`chip${thread.workspace ? '' : ' chip-warn'}`}
            onClick={() => void pickWorkspace()}
            disabled={running}
            title={thread.workspace || 'Elegí la carpeta donde trabaja el agente'}
          >
            <Icon icon={Folder} size="sm" /> {thread.workspace ? folderName(thread.workspace) : 'Elegir carpeta'}
          </button>
        </div>
      </header>

      <div
        className="messages"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        {thread.messages.length === 0 && !running && (
          <div className="welcome">
            <h3>{agent ? `Hablás con ${agent.name}` : 'Nueva conversación'}</h3>
            <p className="muted">{agent?.description}</p>
            {!thread.workspace && (
              <p>
                <button className="link" onClick={() => void pickWorkspace()}>
                  Elegí una carpeta de trabajo
                </button>{' '}
                para que el agente pueda leer y modificar archivos.
              </p>
            )}
          </div>
        )}
        <MessageList
          thread={thread}
          messages={thread.messages}
          draft={drafts[thread.id]}
          drafts={drafts}
          approvals={approvals}
          running={running}
        />
        {error && (
          <div className="error-banner">
            <span>{error}</span>
            <div className="row">
              {/api key|autenticaci|authentication|401/i.test(error) && (
                <button className="ghost small" onClick={props.onOpenSettings}>
                  Configurar proveedor
                </button>
              )}
              <button className="icon-button" onClick={props.onDismissError} title="Cerrar">
                <Icon icon={X} size="sm" />
              </button>
            </div>
          </div>
        )}
      </div>

      <footer className="composer">
        {(attachments.length > 0 || images.length > 0) && (
          <div className="attachments" aria-label="Adjuntos">
            {attachments.map((a) => (
              <span key={a.id} className="attachment" title={a.body.slice(0, 400)}>
                <Icon icon={Paperclip} size={12} />
                <span className="ellipsis">{a.label}</span>
                <button className="icon-button" title="Quitar" onClick={() => props.onRemoveAttachment?.(a.id)}>
                  <Icon icon={X} size={12} />
                </button>
              </span>
            ))}
            {images.map((a) => (
              <span key={a.id} className="attachment" title={a.path}>
                <Icon icon={ImageIcon} size={12} />
                <span className="ellipsis">{a.label}</span>
                <button className="icon-button" title="Quitar" onClick={() => setImages((list) => list.filter((i) => i.id !== a.id))}>
                  <Icon icon={X} size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          value={text}
          placeholder={
            running
              ? 'El agente está trabajando…'
              : attachments.length
                ? '¿Qué querés saber de lo adjuntado?'
                : compact
                  ? 'Preguntale algo, o arrastrá un archivo del vault acá.'
                  : 'Escribí una tarea. Enter envía, Shift+Enter agrega una línea.'
          }
          rows={compact ? 2 : 3}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
            if (pasted.length) {
              e.preventDefault()
              void addImages(pasted)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
        />
        <div className="composer-bar">
          <label className="control" title={mode?.hint}>
            <span>Aprobación</span>
            <select
              value={settings.approvalMode}
              onChange={(e) => void props.onUpdateSettings({ approvalMode: e.target.value as ApprovalMode })}
            >
              {APPROVAL_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="control">
            <span>Agente</span>
            <select value={thread.agentId} disabled={running} onChange={(e) => void request({ method: 'threads.update', threadId: thread.id, agentId: e.target.value })}>
              {settings.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.companyId ? `${settings.companies.find((co) => co.id === a.companyId)?.name ?? 'Empresa'} · ` : ''}
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small grow ellipsis">{agent ? `${thread.model ? `${PROVIDER_NAMES[thread.model.provider]} · ${thread.model.model}` : agent.model || 'modelo automático'} · esfuerzo ${agent.effort}` : ''}</span>
          {running ? (
            <button className="danger" onClick={() => void request({ method: 'chat.stop', threadId: thread.id })}>
              <Icon icon={Square} size="sm" /> Detener
            </button>
          ) : (
            <button className="primary" onClick={() => void send()} disabled={!text.trim()}>
              Enviar <Icon icon={CornerDownLeft} size="sm" />
            </button>
          )}
        </div>
      </footer>
    </main>
  )
}
