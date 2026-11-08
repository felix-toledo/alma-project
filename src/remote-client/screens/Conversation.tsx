// One of the PC's conversations from the phone: the last messages, earlier ones on request, and a composer when continuing is on.
// It follows live only when the phone is writing into it; any other conversation is a snapshot with a refresh (AC-3.11).
import { RefreshCw, Send, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { validateChatInput, type ChatValidation } from '../lib/chat'
import { approvalsFor, conversationMode } from '../lib/conversations'
import type { NavAction } from '../lib/nav'
import type { Pwa } from '../usePwa'
import { ApprovalCard } from './Approvals'
import { BackHeader } from './BackHeader'
import { StateView } from './StateView'
import { useConversation } from './useConversation'

type Props = { pwa: Pwa; language: PwaLanguage; go(action: NavAction): void; id: string; current: boolean; title?: string }

export function Conversation({ pwa, language, go, id, current, title }: Props): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const [wrote, setWrote] = useState(false)
  const live = current || wrote
  const talk = useConversation(pwa, id, live)
  const [draft, setDraft] = useState('')
  const [validation, setValidation] = useState<ChatValidation>({ ok: false, reason: 'empty' })
  const content = talk.state.kind === 'content' ? talk.state.data : null
  const newest = content?.messages.at(-1)?.index

  // A new conversation starts at its end, and so does a new message while the person is reading along.
  useEffect(() => {
    if (newest !== undefined) window.scrollTo(0, document.body.scrollHeight)
  }, [newest, id])

  const type = (text: string): void => {
    setDraft(text)
    setValidation(validateChatInput(text))
  }
  const send = (): void => {
    const checked = validateChatInput(draft)
    setValidation(checked)
    if (!checked.ok) return
    // The typed text stays until the PC accepts it (AC-6.4).
    void talk.send(draft).then((accepted) => {
      if (!accepted) return
      setWrote(true)
      setDraft('')
      setValidation({ ok: false, reason: 'empty' })
    })
  }

  return (
    <main className="pwa">
      <BackHeader language={language} title={title || t('remote.pwa.new')} subtitle={current ? t('remote.pwa.thread.current') : undefined}
        onBack={() => go({ type: 'back' })}
        action={
          content && !live ? (
            <button type="button" className="ghost pwa-icon" aria-label={t('remote.pwa.refresh')} disabled={talk.busy} onClick={() => void talk.refresh()}>
              <RefreshCw size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          ) : undefined
        }
      />
      <StateView state={talk.state} language={language} empty="remote.pwa.thread.gone" onRetry={talk.reload}>
        {(view) => {
          const mode = conversationMode({ running: view.running, waiting: view.waiting, continueOn: talk.continueOn, ownRun: view.ownRun })
          const approvals = approvalsFor(pwa.state?.approvals ?? [], id, current)
          return (
            <>
              {view.earlier && (
                <div className="pwa-actions pwa-center">
                  <button type="button" className="ghost" disabled={talk.busy} onClick={() => void talk.loadEarlier()}>
                    {t('remote.pwa.loadEarlier')}
                  </button>
                </div>
              )}
              <ol className="pwa-messages" aria-live={live ? 'polite' : undefined}>
                {view.messages.map((message) => (
                  <li key={message.index} className={message.role === 'user' ? 'pwa-user' : 'pwa-agent'}>
                    {message.text}
                  </li>
                ))}
              </ol>
              {approvals.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} language={language} onAnswer={(approvalId, decision) => void pwa.answer(approvalId, decision)} />
              ))}
              <div className="pwa-status" role="status">
                {mode.notice && <p className="pwa-note">{t(mode.notice)}</p>}
                {talk.note && <p className="pwa-error">{t(talk.note)}</p>}
                {!validation.ok && validation.reason === 'too-long' && <p className="pwa-error">{t('remote.pwa.tooLong')}</p>}
              </div>
              {(mode.compose || mode.stop) && (
                <div className="pwa-compose pwa-dock">
                  {mode.compose && (
                    <>
                      <textarea value={draft} rows={2} aria-label={t('remote.pwa.thread.compose')} placeholder={t('remote.pwa.thread.compose')} onChange={(e) => type(e.target.value)} />
                      <button type="button" className="primary" disabled={!validation.ok || talk.busy} onClick={send}>
                        <Send size={20} strokeWidth={1.75} aria-hidden="true" />
                        {t('remote.pwa.send')}
                      </button>
                    </>
                  )}
                  {mode.stop && (
                    <button type="button" className="danger" disabled={talk.busy} onClick={() => void talk.stop()}>
                      <Square size={20} strokeWidth={1.75} aria-hidden="true" />
                      {t('remote.pwa.stop')}
                    </button>
                  )}
                </div>
              )}
            </>
          )
        }}
      </StateView>
    </main>
  )
}
