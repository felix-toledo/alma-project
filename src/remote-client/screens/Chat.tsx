// Chat with the agent and its approval cards (T43).
import { MessagesSquare, Plus, Send, Square } from 'lucide-react'
import { useState } from 'react'
import type { ApprovalView } from '../../shared/remote/api'
import { isApproval } from '../lib/conversations'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { validateChatInput } from '../lib/chat'
import type { NavAction } from '../lib/nav'
import type { PwaMessage, PwaState } from '../lib/poll'
import type { Pwa } from '../usePwa'
import { ApprovalCard } from './Approvals'
import { AttachButton, AttachChips, AttachNotes } from './AttachBar'
import { FileLines } from './FileLines'
import { PwaHeader } from './Header'
import { useAttachments } from './useAttachments'

export function Chat({ pwa, language, go }: { pwa: Pwa; language: PwaLanguage; go(action: NavAction): void }): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const attach = useAttachments(pwa, {})
  const state: PwaState | null = pwa.state
  const messages: PwaMessage[] = state?.messages ?? []
  const approvals: ApprovalView[] = (state?.approvals ?? []).filter(isApproval)

  const ids = attach.readyIds()
  const validation = validateChatInput(draft, ids.length)
  const running = Boolean(state?.running) || sending

  const send = async (): Promise<void> => {
    setSending(true)
    try {
      // The typed text and the chips stay until the PC accepts the message (AC-8.1, AC-8.4, 031 AC-4.3).
      const outcome = await pwa.send(draft, ids.length > 0 ? ids : undefined)
      attach.sent(outcome)
      if (outcome.ok) setDraft('')
    } finally {
      setSending(false)
    }
  }

  return (
    <main className="pwa">
      <PwaHeader
        language={language}
        title={t('remote.pwa.tab.chat')}
        action={
          <button type="button" className="ghost" onClick={() => go({ type: 'openConversations' })}>
            <MessagesSquare size={20} strokeWidth={1.75} aria-hidden="true" />
            {t('remote.pwa.threads.title')}
          </button>
        }
      />
      <div className="pwa-actions">
        <button type="button" className="ghost" onClick={() => void pwa.newConversation()}>
          <Plus size={20} strokeWidth={1.75} aria-hidden="true" />
          {t('remote.pwa.new')}
        </button>
        {state?.running && (
          <button type="button" className="ghost" onClick={() => void pwa.stop()}>
            <Square size={20} strokeWidth={1.75} aria-hidden="true" />
            {t('remote.pwa.stop')}
          </button>
        )}
      </div>
      <ol className="pwa-messages">
        {messages.map((message) => (
          <li key={message.index} className={message.role === 'user' ? 'pwa-user' : 'pwa-agent'}>
            {message.text}
            <FileLines attachments={message.attachments} language={language} />
          </li>
        ))}
      </ol>
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} language={language} onAnswer={(id, decision) => void pwa.answer(id, decision)} />
      ))}
      <div className="pwa-status" role="status">
        {pwa.note && <p className="pwa-note">{t(pwa.note)}</p>}
        {!validation.ok && validation.reason === 'too-long' && <p className="pwa-error">{t('remote.pwa.tooLong')}</p>}
        <AttachNotes attach={attach} language={language} />
      </div>
      <AttachChips attach={attach} language={language} locked={sending} />
      <div className="pwa-compose">
        <AttachButton attach={attach} language={language} running={running} />
        <textarea value={draft} rows={2} aria-label={t('remote.pwa.thread.compose')} placeholder={t('remote.pwa.thread.compose')} onChange={(e) => setDraft(e.target.value)} />
        <button type="button" className="primary" disabled={!validation.ok || !attach.canSend(draft, running)} onClick={() => void send()}>
          <Send size={20} strokeWidth={1.75} aria-hidden="true" />
          {t('remote.pwa.send')}
        </button>
      </div>
    </main>
  )
}
