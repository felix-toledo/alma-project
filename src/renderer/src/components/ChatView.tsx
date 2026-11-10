import { useEffect, useRef, useState } from 'react'
import type { ApprovalMode, PendingApproval, ProviderId, PublicSettings, Thread } from '../../../shared/types'
import { PROVIDER_NAMES } from '../../../shared/defaults'
import { composeMessage } from '../../../shared/attachments'
import { addToMessage, fileAttachment, intakeMessages, pickSources, sourcesFromFiles, type Attachment } from '../lib/attachments'
import type { MessageAttachment } from '../../../shared/attach/compose'
import type { IntakeSource } from '../../../shared/attach/intake'
import { createSerial } from '../../../shared/attach/serial'
import { canAttachTo, canSendMessage, unacknowledgedReaders } from '../../../shared/attach/display'
import { useT } from '../i18n/useT'
import { request } from '../lib/coordinator'
import { approvalModes, folderName, threadTitle } from '../lib/format'
import type { Draft } from '../lib/state'
import { MessageList } from './MessageList'
import { ModelPicker } from './ModelPicker'
import { CornerDownLeft, Folder, Paperclip, Square, X } from 'lucide-react'
import { Icon } from '../umbra/Icon'
import { AttachmentChips } from './AttachmentChips'
import { ProviderNoticeDialog, SecretNameDialog } from './AttachDialogs'

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
  const t = useT()
  const [text, setText] = useState('')
  /** Files stored for the next message (spec 030); they leave with it as ids. */
  const [files, setFiles] = useState<MessageAttachment[]>([])
  // the same chips, current at every moment: an intake that starts after another one reads these, not a render's snapshot
  const filesRef = useRef<MessageAttachment[]>([])
  const intakes = useRef(createSerial())
  const changeFiles = (change: (list: MessageAttachment[]) => MessageAttachment[]): void => {
    filesRef.current = change(filesRef.current)
    setFiles(filesRef.current)
  }
  /** Why the last files were not attached; replaced by the next intake. */
  const [notes, setNotes] = useState<string[]>([])
  /** A dialog waiting for the person's answer: the secret-name warning (AC-3.2) or the provider notice (AC-3.1). */
  const [ask, setAsk] = useState<{ kind: 'secret'; name: string; answer(ok: boolean): void } | { kind: 'notice'; providers: ProviderId[]; answer(ok: boolean): void } | null>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const agent = settings.agents.find((a) => a.id === thread.agentId)
  const modes = approvalModes(t)
  const mode = modes.find((m) => m.value === settings.approvalMode)

  // Follow new output unless the user scrolled up to read.
  useEffect(() => {
    const el = scroller.current
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight
  })

  // A company agent's conversation takes no attachments (AC-1.11): no button, and a drop or paste is refused with a message.
  const canAttach = canAttachTo(thread, settings.agents)

  // Drop, paste and the picker all end here: each file is checked on its own (AC-1.4) and every refusal is shown (AC-2.1).
  // Intakes run one after another: a second drop or paste waits for the first (and its dialog), then counts the chips it left.
  const attachFiles = async (sources: IntakeSource[]): Promise<void> => {
    if (!sources.length) return
    if (running) {
      setNotes([t('attach.running')])
      return
    }
    await intakes.current(async () => {
      const result = await addToMessage(thread.id, sources, { canAttach, existing: filesRef.current, confirmSecret: (name) => new Promise<boolean>((answer) => setAsk({ kind: 'secret', name, answer })) })
      changeFiles((list) => [...list, ...result.added])
      setNotes(intakeMessages(t, result))
    })
  }

  const removeFile = (item: MessageAttachment): void => {
    changeFiles((list) => list.filter((f) => f.id !== item.id))
    // the stored copy goes at once (AC-1.2); a failure leaves it for the 30-day sweep
    void request({ method: 'attachments.remove', id: item.id }).catch(() => undefined)
  }

  /** True when every provider that will read the files was already told, or the person accepts the notice now (remembered per provider). */
  const acknowledgeProviders = async (): Promise<boolean> => {
    const readers = await request<ProviderId[]>({ method: 'attachments.readers', threadId: thread.id, images: files.some((f) => f.kind === 'image') })
    const known = settings.attachments.noticeAcknowledged
    const owed = unacknowledgedReaders(readers, known)
    if (!owed.length) return true
    if (!(await new Promise<boolean>((answer) => setAsk({ kind: 'notice', providers: owed, answer })))) return false
    await props.onUpdateSettings({ attachments: { noticeAcknowledged: [...known, ...owed] } })
    return true
  }

  const send = async (): Promise<void> => {
    const message = text.trim()
    if (!canSendMessage(message, files.length, running)) return
    try {
      // The first send that reaches a provider shows the notice; cancelling keeps the text and the chips (AC-3.1).
      if (files.length && !(await acknowledgeProviders())) return
      setText('')
      stickToBottom.current = true
      await request({ method: 'chat.send', threadId: thread.id, text: composeMessage(message, attachments), ...(files.length ? { attachments: files.map((f) => f.id) } : {}) })
      props.onClearAttachments?.()
      changeFiles(() => [])
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
        // Files dragged in from the computer, of any type: each is checked and attached or refused with a reason.
        const dropped = [...e.dataTransfer.files]
        if (dropped.length) {
          e.preventDefault()
          void attachFiles(sourcesFromFiles(dropped))
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
          <h2 className="ellipsis" onDoubleClick={() => setEditingTitle(true)} title={t('chat.rename')}>
            {threadTitle(thread.title, t)}
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
            title={thread.workspace || t('chat.pickFolderTitle')}
          >
            <Icon icon={Folder} size="sm" /> {thread.workspace ? folderName(thread.workspace) : t('chat.pickFolder')}
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
            <h3>{agent ? t('chat.talkingTo', { name: agent.name }) : t('common.newConversation')}</h3>
            <p className="muted">{agent?.description}</p>
            {!thread.workspace && (
              <p>
                <button className="link" onClick={() => void pickWorkspace()}>
                  {t('chat.needFolder')}
                </button>{' '}
                {t('chat.needFolderWhy')}
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
                  {t('chat.configureProvider')}
                </button>
              )}
              <button className="icon-button" onClick={props.onDismissError} title={t('common.close')}>
                <Icon icon={X} size="sm" />
              </button>
            </div>
          </div>
        )}
      </div>

      <footer className="composer">
        {notes.length > 0 && (
          <div className="attach-notes notice" role="status">
            <ul>
              {notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
            <button type="button" className="icon-button" title={t('common.close')} onClick={() => setNotes([])}>
              <Icon icon={X} size={12} />
            </button>
          </div>
        )}
        {(attachments.length > 0 || files.length > 0) && (
          <div className="attachments" aria-label={t('chat.attachments')}>
            {attachments.map((a) => (
              <span key={a.id} className="attachment" title={a.body.slice(0, 400)}>
                <Icon icon={Paperclip} size={12} />
                <span className="ellipsis">{a.label}</span>
                <button className="icon-button" title={t('chat.removeAttachment')} onClick={() => props.onRemoveAttachment?.(a.id)}>
                  <Icon icon={X} size={12} />
                </button>
              </span>
            ))}
            <AttachmentChips items={files} onRemove={removeFile} />
          </div>
        )}
        <textarea
          value={text}
          placeholder={
            running
              ? t('chat.placeholder.running')
              : attachments.length || files.length
                ? t('chat.placeholder.attached')
                : compact
                  ? t('chat.placeholder.compact')
                  : t('chat.placeholder.default')
          }
          rows={compact ? 2 : 3}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // Pictures and files copied in Explorer arrive as files; plain text pastes as usual.
            const pasted = [...e.clipboardData.files]
            if (pasted.length) {
              e.preventDefault()
              void attachFiles(sourcesFromFiles(pasted))
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
          {canAttach && (
            <button
              type="button"
              className="ghost"
              disabled={running}
              title={t('attach.button')}
              aria-label={t('attach.button')}
              onClick={() => void pickSources().then(attachFiles)}
            >
              <Icon icon={Paperclip} size="sm" />
            </button>
          )}
          <label className="control" title={mode?.hint}>
            <span>{t('chat.approval')}</span>
            <select
              value={settings.approvalMode}
              onChange={(e) => void props.onUpdateSettings({ approvalMode: e.target.value as ApprovalMode })}
            >
              {modes.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label className="control">
            <span>{t('chat.agent')}</span>
            <select value={thread.agentId} disabled={running} onChange={(e) => void request({ method: 'threads.update', threadId: thread.id, agentId: e.target.value })}>
              {settings.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.companyId ? `${settings.companies.find((co) => co.id === a.companyId)?.name ?? t('chat.companyFallback')} · ` : ''}
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <span className="muted small grow ellipsis">{agent ? t('chat.modelLine', { model: thread.model ? `${PROVIDER_NAMES[thread.model.provider]} · ${thread.model.model}` : agent.model || t('chat.autoModel'), effort: agent.effort }) : ''}</span>
          {running ? (
            <button className="danger" onClick={() => void request({ method: 'chat.stop', threadId: thread.id })}>
              <Icon icon={Square} size="sm" /> {t('chat.stop')}
            </button>
          ) : (
            <button className="primary" onClick={() => void send()} disabled={!canSendMessage(text, files.length, running)}>
              {t('chat.send')} <Icon icon={CornerDownLeft} size="sm" />
            </button>
          )}
        </div>
      </footer>
      {ask?.kind === 'secret' && (
        <SecretNameDialog
          name={ask.name}
          onChoose={(ok) => {
            ask.answer(ok)
            setAsk(null)
          }}
        />
      )}
      {ask?.kind === 'notice' && (
        <ProviderNoticeDialog
          providers={ask.providers}
          onChoose={(ok) => {
            ask.answer(ok)
            setAsk(null)
          }}
        />
      )}
    </main>
  )
}
