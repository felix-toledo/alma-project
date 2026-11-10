// What was attached to a message (spec 031 AC-5.1, AC-8.8): name, a kind icon and size as plain text. No thumbnail, no link and
// no id: the phone cannot open an attachment, only see what the agent was given.
import { FileText, ImageIcon } from 'lucide-react'
import type { PhoneAttachmentView } from '../../shared/attach/phone'
import { formatSize } from '../../shared/attach/compose'
import type { AttachmentKind } from '../../shared/attach/rules'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'

const KIND_KEYS: Record<AttachmentKind, PwaKey> = {
  image: 'remote.pwa.attach.kind.image',
  text: 'remote.pwa.attach.kind.text',
  pdf: 'remote.pwa.attach.kind.pdf',
  office: 'remote.pwa.attach.kind.office'
}

export function FileLines({ attachments, language }: { attachments?: PhoneAttachmentView[]; language: PwaLanguage }): React.JSX.Element | null {
  if (!attachments || attachments.length === 0) return null
  // The phone is never given an id, so a key is the file's own look plus how many identical ones came before it.
  const seen = new Map<string, number>()
  return (
    <ul className="pwa-actions pwa-list">
      {attachments.map((file) => {
        const Icon = file.kind === 'image' ? ImageIcon : FileText
        const look = `${file.name}|${file.kind}|${file.size}`
        const nth = seen.get(look) ?? 0
        seen.set(look, nth + 1)
        return (
          <li key={`${look}|${nth}`} className="pwa-chip" data-state="sent">
            <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
            <span>{file.name}</span>
            <span>
              {formatSize(file.size)}
              <span className="pwa-sr">, {translatePwa(language, KIND_KEYS[file.kind])}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
