// «Configuración → Casa»: turn the module on, install or connect the engine, choose who answers the rules, see the connected
// accounts (the model that looks at pictures is chosen in Images now, spec 038). Everything is per computer: each person sets up what they have.
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { HomeEngineStatus, HomeEntry } from '../../../shared/home'
import { PROVIDER_NAMES } from '../../../shared/defaults'
import { resolveVision } from '../../../shared/images/vision'
import type { PublicSettings } from '../../../shared/types'
import { useT } from '../i18n/useT'
import { onEvent, request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'
import './home.css'

interface Props {
  settings: PublicSettings
  onChange(patch: Partial<PublicSettings>): Promise<void>
  onSettingsReplaced(settings: PublicSettings): void
  /** Opens the Images tab, where the model that looks at pictures is chosen (spec 038). */
  onOpenImages?(): void
}

export function HomeSettings({ settings, onChange, onOpenImages }: Props): React.JSX.Element {
  const t = useT()
  const config = settings.home
  const looks = resolveVision(settings, (p) => settings.providers[p].hasKey || settings.providers[p].fromEnv)
  const patch = (next: Partial<typeof config>): Promise<void> => onChange({ home: { ...config, ...next } })
  const [engine, setEngine] = useState<HomeEngineStatus | null>(null)
  const [entries, setEntries] = useState<HomeEntry[]>([])
  const [url, setUrl] = useState(config.externalUrl)
  const [token, setToken] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [login, setLogin] = useState<{ url: string; username: string; password: string } | null>(null)

  const reload = useCallback(() => {
    void request<HomeEngineStatus>({ method: 'home.status' }).then(setEngine)
  }, [])
  useEffect(() => {
    reload()
    return onEvent((event) => {
      if (event.type === 'home.engine') setEngine(event.status)
    })
  }, [reload])
  useEffect(() => {
    if (engine?.state !== 'ready') return setEntries([])
    void request<HomeEntry[]>({ method: 'home.entries' }).then(setEntries).catch(() => setEntries([]))
  }, [engine?.state])

  const state = engine?.state ?? 'off'
  const busy = state === 'installing' || state === 'starting'

  return (
    <>
      <div className="card">
        <h3>{t('home.settings.title')}</h3>
        <p className="muted small">
          {t('home.settings.about')}
        </p>
        <label className="row">
          <input type="checkbox" checked={config.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} /> {t('home.enable')}
        </label>
        {config.enabled && (
          <fieldset className="field">
            <legend>{t('home.engine')}</legend>
            <label className="row">
              <input type="radio" name="home-mode" checked={config.mode === 'managed'} onChange={() => void patch({ mode: 'managed' })} /> {t('home.mode.managed')}
            </label>
            <label className="row">
              <input type="radio" name="home-mode" checked={config.mode === 'external'} onChange={() => void patch({ mode: 'external' })} /> {t('home.mode.external')}
            </label>
          </fieldset>
        )}
      </div>

      {config.enabled && (
        <div className="card">
          <h3>
            {t('home.engine.state')} <span className={`badge ${state === 'ready' ? 'ok' : state === 'error' || state === 'unsupported' ? 'danger' : 'warn'}`}>{t(`home.engine.${state}`)}</span>
          </h3>
          {engine?.version && <p className="muted small">{t('home.engine.version', { version: engine.version, url: engine.url ?? '' })}</p>}
          {busy && (
            <>
              <p>
                <Icon icon={Loader2} size={14} className="spin" /> {engine?.step}
              </p>
              {engine?.progress !== undefined && <progress value={engine.progress} max={1} style={{ width: '100%' }} />}
            </>
          )}
          {engine?.error && <p className="small text-danger">{engine.error}</p>}

          {config.mode === 'managed' ? (
            <>
              <p className="muted small">
                {t('home.managedNote')}
              </p>
              <div className="row">
                {state === 'missing' && (
                  <button className="primary" onClick={() => void request({ method: 'home.install' })}>
                    {t('home.installEngine')}
                  </button>
                )}
                {state === 'error' && (
                  <button className="primary" onClick={() => void request({ method: 'home.start' })}>
                    {t('error.retry')}
                  </button>
                )}
                {state === 'ready' && (
                  <button onClick={() => void request({ method: 'home.stop' })}>{t('chat.stop')}</button>
                )}
                {state === 'off' && (
                  <button className="primary" onClick={() => void request({ method: 'home.start' })}>
                    {t('home.start')}
                  </button>
                )}
                {(state === 'ready' || state === 'error') && (
                  <button
                    className="ghost danger-text"
                    onClick={() => confirm(t('home.uninstallConfirm')) && void request({ method: 'home.uninstall' })}
                  >
                    {t('home.uninstall')}
                  </button>
                )}
                {state === 'ready' && (
                  <button
                    className="ghost"
                    onClick={() => void request<{ url: string; username: string; password: string } | null>({ method: 'home.advanced' }).then(setLogin)}
                    title={t('home.advancedTitle')}
                  >
                    {t('home.advanced')}
                  </button>
                )}
              </div>
              {login && (
                <div className="card">
                  <p className="small">
                    {t('home.login.about')}
                  </p>
                  <p className="mono">
                    {t('home.login.user', { value: login.username })}
                    <br />
                    {t('home.login.password', { value: login.password })}
                  </p>
                  <div className="row">
                    <a className="button primary" href={login.url} target="_blank" rel="noreferrer">
                      {t('home.login.open', { url: login.url })}
                    </a>
                    <button className="ghost" onClick={() => setLogin(null)}>
                      {t('home.login.hide')}
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <label className="field">
                <span>{t('home.ext.url')}</span>
                <input placeholder="http://192.168.1.20:8123" value={url} onChange={(e) => setUrl(e.target.value)} />
              </label>
              <label className="field">
                <span>{t('home.ext.token')}</span>
                <input type="password" placeholder={t('home.ext.tokenExample')} value={token} onChange={(e) => setToken(e.target.value)} />
              </label>
              <div className="row">
                <button
                  className="primary"
                  disabled={!url.trim() || !token.trim()}
                  onClick={async () => {
                    setNote(null)
                    try {
                      await patch({ externalUrl: url.trim().replace(/\/+$/, '') })
                      await request({ method: 'home.connectExternal', url: url.trim(), token: token.trim() })
                      setToken('')
                      setNote({ ok: true, text: t('home.ext.connected') })
                    } catch (error) {
                      setNote({ ok: false, text: (error as Error).message })
                    }
                  }}
                >
                  {t('home.ext.connect')}
                </button>
                {note && <span className={`small ${note.ok ? '' : 'text-danger'}`}>{note.text}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {config.enabled && (
        <div className="card">
          <h3>{t('home.think.title')}</h3>
          <label className="field">
            <span>{t('home.think.agent')}</span>
            <select value={config.agentId} onChange={(e) => void patch({ agentId: e.target.value })}>
              <option value="">{t('home.think.defaultAgent')}</option>
              {settings.agents
                .filter((a) => !a.companyId)
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="field">
            <span>{t('home.think.vision')}</span>
            <div className="row">
              <span className="small grow">{t('home.think.visionUsing', { provider: PROVIDER_NAMES[looks.provider], model: looks.model || (looks.via === 'chosen' ? t('home.think.visionAuto') : '—') })}</span>
              {onOpenImages && (
                <button className="ghost small" onClick={onOpenImages}>
                  {t('home.think.visionOpen')}
                </button>
              )}
            </div>
            <span className="muted small">{t('home.think.visionNote')}</span>
          </div>
        </div>
      )}

      {config.enabled && entries.length > 0 && (
        <div className="card">
          <h3>{t('home.accounts')}</h3>
          {entries.map((entry) => (
            <div key={entry.entryId} className="row space">
              <span>
                <b>{entry.title}</b> <span className="muted small">{entry.domain} · {entry.state === 'loaded' ? t('home.entry.active') : entry.state}</span>
              </span>
              <button
                className="ghost small danger-text"
                onClick={() => confirm(t('home.entry.removeConfirm', { title: entry.title })) && void request({ method: 'home.entry.remove', entryId: entry.entryId }).then(() => setEntries((list) => list.filter((e) => e.entryId !== entry.entryId)))}
              >
                {t('common.remove')}
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
