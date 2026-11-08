// «Configuración → Acceso remoto»: the off-by-default switch, the Tailscale wizard,
// pairing, devices, scopes, cameras and activity. Step logic is pure (T36);
// this file only renders.
import type { RemoteFailure, RemoteStatus } from '../../../shared/types'
import { wizardStep } from '../../../shared/remote/view'
import type { PublicSettings } from '../../../shared/types'
import { useT } from '../i18n/useT'
import { request } from '../lib/coordinator'
import { ActivityCard } from './ActivityCard'
import { DevicesCard } from './DevicesCard'
import { PairingCard } from './PairingCard'
import './remote.css'
import { ScopesCard } from './ScopesCard'
import { useRemote } from './useRemote'

interface Props {
  settings: PublicSettings
  onChange(patch: Partial<PublicSettings>): Promise<void>
  onSettingsReplaced(settings: PublicSettings): void
}

const STATUS_BADGE: Record<RemoteStatus['state'], string> = { off: '', connecting: 'warn', online: 'ok', error: 'danger' }

function causeText(t: ReturnType<typeof useT>, status: RemoteStatus): string | null {
  const failure: RemoteFailure | undefined = status.failure
  if (!failure) return null
  // Literal keys: the typed `t()` reads each key's params from the dictionaries.
  if (failure === 'listener') return t('remote.wizard.fail.listener', { reason: status.detail ?? '' })
  if (failure === 'portTaken') return t('remote.wizard.fail.portTaken', { port: status.detail ?? '' })
  if (failure === 'noInternet') return t('remote.wizard.fail.noInternet')
  if (failure === 'tailscaleDown') return t('remote.wizard.fail.tailscaleDown')
  if (failure === 'httpsOff') return t('remote.wizard.fail.httpsOff')
  if (failure === 'phoneSilent') return t('remote.wizard.fail.phoneSilent')
  return t('remote.wizard.fail.serveBusy')
}

export function RemoteSettings({ settings, onChange }: Props): React.JSX.Element {
  const t = useT()
  const config = settings.remote
  const patch = (next: Partial<typeof config>): Promise<void> => onChange({ remote: { ...config, ...next } })
  const { status, pairing, devices, tested, activity, tailscale, detect } = useRemote(config.enabled)
  const step = tailscale ? wizardStep({ tailscale, status, devices: devices.length }) : null
  const cause = causeText(t, status)

  const open = (target: 'tailscale-download' | 'tailscale-terms'): void => {
    void request({ method: 'remote.open', target })
  }
  const serve = (): void => {
    void request({ method: 'remote.serve' }).then(detect).catch(() => undefined)
  }
  const pickPort = (): void => {
    void request({ method: 'remote.pickPort' }).then(detect).catch(() => undefined)
  }
  const revokeOld = (): void => {
    // The native confirmation is main's (BR-39 goes through "Revoke all").
    void request({ method: 'remote.revokeAll' }).catch(() => undefined)
  }

  return (
    <>
      <div className="card">
        <h3>{t('settings.tab.remote')}</h3>
        <label className="row">
          <input type="checkbox" checked={config.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} /> {t('remote.enable')}
        </label>
        {!config.enabled && <p className="muted small">{t('remote.offByDefault.hint')}</p>}
      </div>

      {config.enabled && (
        <div className="card">
          <h3>
            <span className={`badge ${STATUS_BADGE[status.state]}`}>{t(`channels.state.${status.state}`)}</span>
          </h3>
          {cause && <p className="muted small">{cause}</p>}
          {status.address && <p className="muted small">{status.address}</p>}
          {status.keyExpiresInDays !== undefined && status.keyExpiresInDays < 14 && (
            <p className="text-warn small">{t('remote.wizard.keyExpiry', { count: status.keyExpiresInDays })}</p>
          )}
          {status.renamed && (
            <>
              <p className="text-warn small">{t('remote.wizard.renamed')}</p>
              <button type="button" onClick={revokeOld}>
                {t('remote.wizard.renamed.revoke')}
              </button>
            </>
          )}
        </div>
      )}

      {config.enabled && step && (
        <div className="card remote-wizard">
          {step === 'download' && (
            <>
              <p>{t('remote.wizard.tailscale.missing')}</p>
              <button type="button" onClick={() => open('tailscale-download')}>
                {t('remote.wizard.tailscale.download')}
              </button>
            </>
          )}
          {step === 'tailscale' && (
            <>
              <p>{t('remote.wizard.tailscale.disconnected')}</p>
              <button type="button" onClick={detect}>
                {t('remote.wizard.test')}
              </button>
            </>
          )}
          {step === 'https' && (
            <>
              <p>{t('remote.wizard.fail.httpsOff')}</p>
              <button type="button" onClick={detect}>
                {t('remote.wizard.test')}
              </button>
            </>
          )}
          {step === 'serve' && (
            <>
              <p>{t('remote.wizard.tailscale.found')}</p>
              <div className="remote-actions">
                <button type="button" onClick={serve}>
                  {t('remote.wizard.serve')}
                </button>
                {status.failure === 'portTaken' && (
                  <button type="button" onClick={pickPort}>
                    {t('remote.wizard.port.pick')}
                  </button>
                )}
              </div>
            </>
          )}
          {step === 'test' && (
            <button type="button" onClick={detect}>
              {t('remote.wizard.test')}
            </button>
          )}
          {(step === 'pair' || step === 'ready') && <p>{t('remote.wizard.test.ok')}</p>}

          <ul className="muted small remote-notices">
            <li>
              {t('remote.wizard.notice.plan')}{' '}
              <button type="button" className="remote-link" onClick={() => open('tailscale-terms')}>
                {t('remote.wizard.notice.terms')}
              </button>
            </li>
            <li>{t('remote.wizard.notice.certs')}</li>
            <li>{t('remote.wizard.notice.rename')}</li>
          </ul>
          <p className="muted small">{t('remote.wizard.acl.hint')}</p>
        </div>
      )}

      {config.enabled && (step === 'pair' || step === 'ready') && <PairingCard pairing={pairing} />}
      {config.enabled && <DevicesCard devices={devices} tested={tested} />}
      {config.enabled && <ScopesCard settings={settings} onChange={onChange} />}
      {config.enabled && <ActivityCard activity={activity} />}
    </>
  )
}
