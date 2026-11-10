import { useEffect, useState } from 'react'
import { ExternalLink, FileSpreadsheet, FileText, ImageIcon, X, type LucideIcon } from 'lucide-react'
import { formatSize, type MessageAttachment } from '../../../shared/attach/compose'
import { canOpenWithSystemApp, hasThumbnail, thumbnailSrc } from '../../../shared/attach/display'
import type { AttachmentKind } from '../../../shared/attach/rules'
import type { PreviewResult } from '../../../shared/types'
import { useT } from '../i18n/useT'
import { request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'

export const kindIcon = (kind: AttachmentKind): LucideIcon => (kind === 'image' ? ImageIcon : kind === 'office' ? FileSpreadsheet : FileText)

/** The files already stored for the next message (spec 030 AC-1.1, AC-1.2): name, size and a remove X. File names are plain text. */
export function AttachmentChips({ items, onRemove }: { items: readonly MessageAttachment[]; onRemove(item: MessageAttachment): void }): React.JSX.Element {
  const t = useT()
  return (
    <>
      {items.map((a) => (
        <span key={a.id} className="attachment" title={`${a.name} · ${formatSize(a.size)}`}>
          <Icon icon={kindIcon(a.kind)} size={12} />
          <span className="ellipsis">{a.name}</span>
          <span className="muted">{formatSize(a.size)}</span>
          <button type="button" className="icon-button" title={t('attach.chip.remove', { name: a.name })} aria-label={t('attach.chip.remove', { name: a.name })} onClick={() => onRemove(a)}>
            <Icon icon={X} size={12} />
          </button>
        </span>
      ))}
    </>
  )
}

function SentFile({ item }: { item: MessageAttachment }): React.JSX.Element {
  const t = useT()
  // null while the coordinator has not answered; the stored file may be gone (30 days) or never have been here
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [openError, setOpenError] = useState('')
  useEffect(() => {
    let live = true
    request<PreviewResult>({ method: 'attachments.preview', id: item.id })
      .then((p) => live && setPreview(p))
      .catch(() => live && setPreview({ state: 'unknown' }))
    return () => {
      live = false
    }
  }, [item.id])

  const gone = preview !== null && preview.state !== 'present'
  const src = preview && hasThumbnail(item) ? thumbnailSrc(preview) : undefined
  const open = (): void => {
    setOpenError('')
    request<{ ok: boolean; message: string }>({ method: 'attachments.open', id: item.id })
      .then((r) => !r.ok && setOpenError(r.message))
      .catch((err: Error) => setOpenError(err.message))
  }

  return (
    <li className={`sent-file${gone ? ' gone' : ''}`}>
      {src ? <img className="sent-thumb" src={src} alt="" /> : <Icon icon={kindIcon(item.kind)} size={16} />}
      <span className="sent-file-name ellipsis" title={item.name}>
        {item.name}
      </span>
      <span className="muted small">{formatSize(item.size)}</span>
      {gone && <span className="small">{t('attach.chip.removed')}</span>}
      {preview?.state === 'present' && canOpenWithSystemApp(item.name) && (
        <button type="button" className="icon-button" title={t('attach.chip.open', { name: item.name })} aria-label={t('attach.chip.open', { name: item.name })} onClick={open}>
          <Icon icon={ExternalLink} size={12} />
        </button>
      )}
      {openError && (
        <span className="small text-danger" role="status">
          {openError}
        </span>
      )}
    </li>
  )
}

/** What a sent message carried (spec 030 AC-7.1): the structured list, so it survives a restart. Names and errors are plain text. */
export function SentAttachments({ items }: { items: readonly MessageAttachment[] }): React.JSX.Element {
  const t = useT()
  return (
    <ul className="sent-files" aria-label={t('chat.attachments')}>
      {items.map((a) => (
        <SentFile key={a.id} item={a} />
      ))}
    </ul>
  )
}
