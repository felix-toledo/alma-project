// The PC's conversations from the phone: newest first, 30 a page with "load more". Nothing is kept; every visit asks again (BR-26).
import { ChevronRight, MessageCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { joinPage, listEvent, rowSub, type ListView } from '../lib/conversations'
import type { NavAction } from '../lib/nav'
import type { Pwa } from '../usePwa'
import { BackHeader } from './BackHeader'
import { StateView } from './StateView'
import { useLoad } from './useLoad'

type Props = { pwa: Pwa; language: PwaLanguage; go(action: NavAction): void }

function Rows({ pwa, language, go, first, scrolls }: Props & { first: ListView; scrolls: Map<string, number> }): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const [view, setView] = useState(first)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<PwaKey | null>(null)
  const now = Date.now()

  const more = async (): Promise<void> => {
    setBusy(true)
    const joined = joinPage(view, await pwa.threads.list(view.offset))
    setBusy(false)
    if ('view' in joined) {
      setNote(null)
      setView(joined.view)
    } else setNote(joined.key)
  }

  return (
    <>
      <ul className="pwa-list">
        {view.rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              onClick={() => {
                scrolls.set('chat:conversations', window.scrollY)
                go({ type: 'openConversation', id: row.id, current: row.current, title: row.title })
              }}
            >
              <MessageCircle className="pwa-list-icon" size={20} strokeWidth={1.75} aria-hidden="true" />
              <span className="pwa-list-text">
                <span className="pwa-list-name">{row.title || t('remote.pwa.new')}</span>
                <span className="pwa-list-sub">{rowSub(row, now, language)}</span>
              </span>
              {row.current && <span className="pwa-badge">{t('remote.pwa.thread.current')}</span>}
              <ChevronRight className="pwa-list-more" size={20} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <div role="status">{note && <p className="pwa-error">{t(note)}</p>}</div>
      {view.more && (
        <div className="pwa-actions pwa-center">
          <button type="button" disabled={busy} aria-busy={busy || undefined} onClick={() => void more()}>
            {t('remote.pwa.loadMore')}
          </button>
        </div>
      )}
    </>
  )
}

export function Conversations({ pwa, language, go, scrolls }: Props & { scrolls: Map<string, number> }): React.JSX.Element {
  const { state, reload } = useLoad<ListView>(async () => listEvent(await pwa.threads.list(0)), 'chat:conversations')
  const restore = scrolls.get('chat:conversations') ?? 0
  // Coming back from a conversation lands where the person left the list.
  useEffect(() => {
    if (state.kind !== 'loading') window.scrollTo(0, restore)
  }, [state.kind, restore])
  return (
    <main className="pwa">
      <BackHeader language={language} title={translatePwa(language, 'remote.pwa.threads.title')} onBack={() => go({ type: 'back' })} />
      <StateView state={state} language={language} empty="remote.pwa.threads.none" onRetry={reload}>
        {(first) => <Rows pwa={pwa} language={language} go={go} first={first} scrolls={scrolls} />}
      </StateView>
    </main>
  )
}
