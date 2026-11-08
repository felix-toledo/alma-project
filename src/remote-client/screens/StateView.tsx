// The states every data screen has (AC-6.3): loading, empty, error, scope off, PC unreachable, revoked. The text and whether a
// retry is offered come from lib/screen-state.ts and lib/outcome.ts; this only draws them.
import { Inbox, KeyRound, Lock, RefreshCw, TriangleAlert, WifiOff, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { LOADING_THRESHOLD_MS, showLoading, type ScreenState } from '../lib/screen-state'

/** An icon, a concrete sentence and, where trying again can help, the retry. */
export function StateMessage({ icon: Icon, text, retry }: { icon: LucideIcon; text: string; retry?: { label: string; run(): void } }): React.JSX.Element {
  return (
    <div className="pwa-state" role="status">
      <span className="pwa-state-icon" aria-hidden="true">
        <Icon size={24} strokeWidth={1.75} />
      </span>
      <p>{text}</p>
      {retry && (
        <button type="button" onClick={retry.run}>
          <RefreshCw size={20} strokeWidth={1.75} aria-hidden="true" />
          {retry.label}
        </button>
      )}
    </div>
  )
}

/** A calm placeholder, drawn only once the wait passes the threshold so a quick answer never flashes it. */
function Loading({ since, language }: { since: number; language: PwaLanguage }): React.JSX.Element | null {
  const [late, setLate] = useState(() => showLoading({ kind: 'loading', since }, Date.now()))
  useEffect(() => {
    if (late) return
    const timer = setTimeout(() => setLate(true), Math.max(0, LOADING_THRESHOLD_MS - (Date.now() - since)))
    return () => clearTimeout(timer)
  }, [late, since])
  if (!late) return null
  return (
    <div className="pwa-skeletons" role="status" aria-busy="true">
      <span className="pwa-sr">{translatePwa(language, 'remote.pwa.loading')}</span>
      {[0, 1, 2, 3, 4].map((row) => (
        <span key={row} className="pwa-skeleton" aria-hidden="true" />
      ))}
    </div>
  )
}

export function StateView<T>({
  state,
  language,
  empty,
  onRetry,
  children
}: {
  state: ScreenState<T>
  language: PwaLanguage
  /** What an empty answer says on this screen (what is missing and what to do). */
  empty: PwaKey
  onRetry?: () => void
  children(data: T): React.ReactNode
}): React.JSX.Element | null {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const retry = onRetry ? { label: t('remote.pwa.retry'), run: onRetry } : undefined
  switch (state.kind) {
    case 'loading':
      return <Loading since={state.since} language={language} />
    case 'content':
      return <>{children(state.data)}</>
    case 'empty':
      return <StateMessage icon={Inbox} text={t(empty)} />
    case 'error':
      return <StateMessage icon={TriangleAlert} text={t(state.key)} retry={state.retry ? retry : undefined} />
    case 'scopeOff':
      return <StateMessage icon={Lock} text={t(state.key)} />
    case 'unreachable':
      return <StateMessage icon={WifiOff} text={t('remote.pwa.pcUnreachable')} retry={retry} />
    case 'revoked':
      return <StateMessage icon={KeyRound} text={t('remote.pwa.revoked')} />
  }
}
