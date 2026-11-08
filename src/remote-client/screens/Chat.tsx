// Chat with the agent and its approval cards (T43).
import { MessagesSquare, Plus, Send, Square } from 'lucide-react'
import { useState } from 'react'
import type { ApprovalView } from '../../shared/remote/api'
import { isApproval } from '../lib/conversations'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { validateChatInput, type ChatValidation } from '../lib/chat'
import type { NavAction } from '../lib/nav'
import type { PwaMessage, PwaState } from '../lib/poll'
import type { Pwa } from '../usePwa'
import { ApprovalCard } from './Approvals'
import { PwaHeader } from './Header'

export function Chat({ pwa, language, go }: { pwa: Pwa; language: PwaLanguage; go(action: NavAction): void }): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const [draft, setDraft] = useState('')
  const [validation, setValidation] = useState<ChatValidation>({ ok: false, reason: 'empty' })
  const state: PwaState | null = pwa.state
  const messages: PwaMessage[] = state?.messages ?? []
  const approvals: ApprovalView[] = (state?.approvals ?? []).filter(isApproval)

  const type = (text: string): void => {
    setDraft(text)
    setValidation(validateChatInput(text))
  }

  const send = (): void => {
    const checked = validateChatInput(draft)
    setValidation(checked)
    if (!checked.ok) return
    // The typed text stays until the PC accepts it (AC-8.1, AC-8.4).
    void pwa.send(draft).then((accepted) => {
      if (accepted) {
        setDraft('')
        setValidation({ ok: false, reason: 'empty' })
      }
    })
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
          </li>
        ))}
      </ol>
      {approvals.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} language={language} onAnswer={(id, decision) => void pwa.answer(id, decision)} />
      ))}
      <div className="pwa-status" role="status">
        {pwa.note && <p className="pwa-note">{t(pwa.note)}</p>}
        {!validation.ok && validation.reason === 'too-long' && <p className="pwa-error">{t('remote.pwa.tooLong')}</p>}
      </div>
      <div className="pwa-compose">
        <textarea value={draft} rows={2} aria-label={t('remote.pwa.thread.compose')} placeholder={t('remote.pwa.thread.compose')} onChange={(e) => type(e.target.value)} />
        <button type="button" className="primary" disabled={!validation.ok || state?.running} onClick={send}>
          <Send size={20} strokeWidth={1.75} aria-hidden="true" />
          {t('remote.pwa.send')}
        </button>
      </div>
    </main>
  )
}
