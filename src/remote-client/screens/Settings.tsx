// Settings from the phone: the connection, what this phone can do right now (read-only, the switches live on the PC), the app's
// version and "Forget this PC". No language switch and no scope control (BR-36).
import { Check, CircleCheck, LogOut, Minus } from 'lucide-react'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { canList } from '../lib/can'
import { statusEvent } from '../lib/status'
import type { StatusView } from '../../shared/remote/wire'
import type { Pwa } from '../usePwa'
import { PwaHeader } from './Header'
import { StateView } from './StateView'
import { useLoad } from './useLoad'

export function Settings({ pwa, language }: { pwa: Pwa; language: PwaLanguage }): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const { state, reload } = useLoad<StatusView>(async () => statusEvent(await pwa.access()), 'settings')
  const forget = (): void => {
    if (!confirm(t('remote.pwa.forget.confirm'))) return
    void pwa.forget()
  }
  return (
    <main className="pwa">
      <PwaHeader language={language} title={t('remote.pwa.tab.settings')} />
      <StateView state={state} language={language} empty="remote.pwa.can.title" onRetry={reload}>
        {(status) => (
          <>
            <section className="pwa-card pwa-connection" aria-label={t('remote.pwa.connection.ok')}>
              <CircleCheck className="pwa-ok" size={20} strokeWidth={1.75} aria-hidden="true" />
              <p role="status">{t('remote.pwa.connection.ok')}</p>
            </section>
            <section aria-labelledby="pwa-can-title">
              <h2 id="pwa-can-title" className="pwa-section">
                {t('remote.pwa.can.title')}
              </h2>
              <ul className="pwa-can">
                {canList(status).map(({ key, on }) => (
                  <li key={key} className={on ? 'pwa-on' : 'pwa-off'}>
                    <span>{t(key)}</span>
                    <span className="pwa-can-state">
                      {on ? <Check size={16} strokeWidth={1.75} aria-hidden="true" /> : <Minus size={16} strokeWidth={1.75} aria-hidden="true" />}
                      {t(on ? 'remote.pwa.can.on' : 'remote.pwa.can.off')}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </StateView>
      <p className="pwa-muted pwa-version">{translatePwa(language, 'remote.pwa.version', { version: __APP_VERSION__ })}</p>
      {pwa.shellHash && <p className="pwa-muted pwa-version pwa-hash">{translatePwa(language, 'remote.pwa.shell.hash', { hash: pwa.shellHash })}</p>}
      <div className="pwa-actions pwa-center">
        <button type="button" className="danger" onClick={forget}>
          <LogOut size={20} strokeWidth={1.75} aria-hidden="true" />
          {t('remote.pwa.forget')}
        </button>
      </div>
    </main>
  )
}
