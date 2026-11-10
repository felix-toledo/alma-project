// Alma on the phone: pair, then five destinations (Chat, Notes, Home, Cameras, Settings).
import { Camera, House, KeyRound, MessageCircle, NotebookText, Settings as SettingsIcon, WifiOff, type LucideIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { phoneLanguage, translatePwa, type PwaKey } from './i18n'
import { entriesToPush, systemBack } from './lib/history'
import { initialNav, NAV_ORDER, navReduce, type NavAction, type NavState, type Tab } from './lib/nav'
import { Pair } from './screens/Pair'
import { Chat } from './screens/Chat'
import { Home } from './screens/Home'
import { Cameras } from './screens/Cameras'
import { Conversation } from './screens/Conversation'
import { Conversations } from './screens/Conversations'
import { Notes } from './screens/Notes'
import { Settings } from './screens/Settings'
import { StateMessage } from './screens/StateView'
import { PwaHeader } from './screens/Header'
import { usePwa } from './usePwa'

const TABS: Record<Tab, { key: PwaKey; icon: LucideIcon }> = {
  chat: { key: 'remote.pwa.tab.chat', icon: MessageCircle },
  notes: { key: 'remote.pwa.tab.notes', icon: NotebookText },
  home: { key: 'remote.pwa.tab.home', icon: House },
  cameras: { key: 'remote.pwa.tab.cameras', icon: Camera },
  settings: { key: 'remote.pwa.tab.settings', icon: SettingsIcon }
}

export function App(): React.JSX.Element {
  const language = phoneLanguage(navigator.language)
  const pwa = usePwa()
  const [nav, setNav] = useState<NavState>(initialNav)
  const navNow = useRef(nav)
  // Which tab each pushed system-history entry belongs to, newest last (see lib/history.ts). Memory only.
  const owners = useRef<Tab[]>([])
  const scrolls = useRef(new Map<string, number>())
  // A fresh QR opens the app with a fragment: pair again even when refused before.
  const [pairing, setPairing] = useState(() => location.hash.startsWith('#p='))

  const commit = useCallback((next: NavState) => {
    navNow.current = next
    setNav(next)
  }, [])

  const go = useCallback(
    (action: NavAction) => {
      const before = navNow.current
      if (action.type === 'back') {
        // The on-screen back is the system back, so the two can never disagree about the entries.
        if (owners.current.length > 0) history.back()
        else commit(navReduce(before, action).state)
        return
      }
      const after = navReduce(before, action).state
      for (const owner of entriesToPush(before, after)) {
        history.pushState(null, '')
        owners.current.push(owner)
      }
      commit(after)
    },
    [commit]
  )

  useEffect(() => {
    const onPop = (): void => {
      const step = systemBack(navNow.current, owners.current.pop())
      // An entry with nothing left to climb is skipped while older ones remain, so one press always shows a change.
      if (step.dead && owners.current.length > 0) history.back()
      commit(step.state)
    }
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [commit])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [nav.tab])

  // The page is served with a fixed lang; a screen reader needs the phone's.
  useEffect(() => {
    document.documentElement.lang = language
  }, [language])

  // The morning greeting lands once (spec 033 BR-29): the PC names it only on the first status call after delivery, with History on.
  const landed = useRef(false)
  useEffect(() => {
    if (pwa.status !== 'ready' || landed.current) return
    landed.current = true
    void pwa.access().then((outcome) => {
      if (!outcome.ok || !outcome.status.landing) return
      go({ type: 'tab', tab: 'chat' })
      go({ type: 'openConversation', id: outcome.status.landing })
    })
  }, [pwa, go])

  if (pairing) {
    return (
      <Pair
        onPaired={() => {
          setPairing(false)
          pwa.paired()
        }}
      />
    )
  }
  if (pwa.status === 'unpaired') return <Pair onPaired={() => pwa.paired()} />
  if (pwa.status === 'ready') {
    return (
      <>
        {nav.tab === 'chat' && nav.chat.view === 'top' && <Chat pwa={pwa} language={language} go={go} />}
        {nav.tab === 'chat' && nav.chat.view === 'conversations' && <Conversations pwa={pwa} language={language} go={go} scrolls={scrolls.current} />}
        {nav.tab === 'chat' && nav.chat.view === 'conversation' && (
          <Conversation key={nav.chat.id} pwa={pwa} language={language} go={go} id={nav.chat.id} current={nav.chat.current === true} title={nav.chat.title} />
        )}
        {nav.tab === 'notes' && <Notes pwa={pwa} language={language} place={nav.notes} go={go} scrolls={scrolls.current} />}
        {nav.tab === 'home' && <Home pwa={pwa} language={language} />}
        {nav.tab === 'cameras' && <Cameras pwa={pwa} language={language} />}
        {nav.tab === 'settings' && <Settings pwa={pwa} language={language} />}
        <nav className="pwa-tabs" aria-label={translatePwa(language, 'remote.pwa.nav')}>
          {NAV_ORDER.map((id) => {
            const { key, icon: Icon } = TABS[id]
            return (
              <button key={id} type="button" aria-current={nav.tab === id ? 'page' : undefined} onClick={() => go({ type: 'tab', tab: id })}>
                <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
                <span>{translatePwa(language, key)}</span>
              </button>
            )
          })}
        </nav>
      </>
    )
  }
  if (pwa.status === 'refused') {
    return (
      <main className="pwa">
        <PwaHeader language={language} />
        <StateMessage icon={KeyRound} text={translatePwa(language, 'remote.pwa.revoked')} />
      </main>
    )
  }
  if (pwa.status === 'unreachable') {
    return (
      <main className="pwa">
        <PwaHeader language={language} />
        <StateMessage icon={WifiOff} text={translatePwa(language, 'remote.pwa.pcUnreachable')} />
      </main>
    )
  }
  return (
    <main className="pwa">
      <PwaHeader language={language} />
      <span className="pwa-spinner" aria-hidden="true" />
      <p className="pwa-note">{translatePwa(language, 'remote.pwa.pairing.waiting')}</p>
    </main>
  )
}
