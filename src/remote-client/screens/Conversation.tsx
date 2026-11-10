// One of the PC's conversations from the phone: the last messages, earlier ones on request, and a composer when continuing is on.
// It follows live only when the phone is writing into it; any other conversation is a snapshot with a refresh (AC-3.11).
import { RefreshCw, Send, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { validateChatInput } from '../lib/chat'
import { approvalsFor, conversationMode } from '../lib/conversations'
import type { NavAction } from '../lib/nav'
import type { Pwa } from '../usePwa'
import { ApprovalCard } from './Approvals'
import { AttachButton, AttachChips, AttachNotes } from './AttachBar'
import { BackHeader } from './BackHeader'
import { FileLines } from './FileLines'
import { StateView } from './StateView'
import { useAttachments } from './useAttachments'
import { useConversation } from './useConversation'

type Props = { pwa: Pwa; language: PwaLanguage; go(action: NavAction): void; id: string; current: boolean; title?: string }

export function Conversation({ pwa, language, go, id, current, title }: Props): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const [wrote, setWrote] = useState(false)
  const live = current || wrote
  const talk = useConversation(pwa, id, live)
  const [draft, setDraft] = useState('')
  const attach = useAttachments(pwa, { id })
  const ids = attach.readyIds()
  const validation = validateChatInput(draft, ids.length)
  const content = talk.state.kind === 'content' ? talk.state.data : null
  const newest = content?.messages.at(-1)?.index

  // A new conversation starts at its end, and so does a new message while the person is reading along.
  useEffect(() => {
    if (newest !== undefined) window.scrollTo(0, document.body.scrollHeight)
  }, [newest, id])

  const send = (): void => {
    // The typed text and the chips stay until the PC accepts the message (AC-6.4, 031 AC-4.3).
    void talk.send(draft, ids.length > 0 ? ids : undefined).then((outcome) => {
      attach.sent(outcome)
      if (!outcome.ok) return
      setWrote(true)
      setDraft('')
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
                    <FileLines attachments={message.attachments} language={language} />
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
                {mode.compose && <AttachNotes attach={attach} language={language} />}
              </div>
              {mode.compose && <AttachChips attach={attach} language={language} locked={talk.busy} />}
              {(mode.compose || mode.stop) && (
                <div className="pwa-compose pwa-dock">
                  {mode.compose && (
                    <>
                      <AttachButton attach={attach} language={language} running={talk.busy} />
                      <textarea value={draft} rows={2} aria-label={t('remote.pwa.thread.compose')} placeholder={t('remote.pwa.thread.compose')} onChange={(e) => setDraft(e.target.value)} />
                      <button type="button" className="primary" disabled={!validation.ok || !attach.canSend(draft, talk.busy)} onClick={send}>
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
