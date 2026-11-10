// «Configuración → Acceso remoto»: the off-by-default switch, how the phone connects (Tailscale or Alma's relay), the
// wizard for the one chosen, pairing, devices, scopes, cameras and activity. Step logic is pure (T36, spec 027 T30);
// this file only renders.
import { useState } from 'react'
import type { RelayFailure, RelayTestCause, RelayTestResult, RemoteFailure, RemoteStatus } from '../../../shared/types'
import { ABUSE_CONTACT } from '../../../shared/remote/relay-config'
import { refusedReasonKey } from '../../../shared/remote/relay-status'
import { relayTab } from '../../../shared/remote/relay-view'
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

/** The relay's own cause, in words. A refusal says why when the relay's close code is known. */
function relayCauseText(t: ReturnType<typeof useT>, failure: RelayFailure, detail: string | undefined): string {
  // The four reason keys take no parameters; the cast only tells the typed `t()` so.
  if (failure === 'relayRefused') return t('remote.relay.fail.refused', { reason: t(refusedReasonKey(detail) as 'remote.relay.refused.other') })
  if (failure === 'relayFull') return t('remote.relay.fail.full')
  if (failure === 'relayVersion') return t('remote.relay.fail.version')
  if (failure === 'relayGone') return t('remote.relay.fail.gone')
  return t('remote.relay.fail.unreachable')
}

function testCauseText(t: ReturnType<typeof useT>, cause: RelayTestCause, detail: string | undefined): string {
  if (cause === 'noInternet') return t('remote.wizard.fail.noInternet')
  if (cause === 'phoneSilent') return t('remote.wizard.fail.phoneSilent')
  return relayCauseText(t, cause, detail)
}

export function RemoteSettings({ settings, onChange }: Props): React.JSX.Element {
  const t = useT()
  const config = settings.remote
  const patch = (next: Partial<typeof config>): Promise<void> => onChange({ remote: { ...config, ...next } })
  const [relayChecked, setRelayChecked] = useState<'idle' | 'running' | RelayTestResult>('idle')
  const { status, pairing, devices, tested, activity, tailscale, detect } = useRemote(config.enabled, config.transport)
  // What to show of the relay (the build may hide it, its causes come in the status) is decided in shared.
  const tab = relayTab(config, status)
  const step = tailscale && tab.tailscaleSteps ? wizardStep({ tailscale, status, devices: devices.length }) : null
  const cause = tab.viaRelay ? (tab.failure ? relayCauseText(t, tab.failure, status.detail) : null) : causeText(t, status)

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
  const testRelay = (): void => {
    setRelayChecked('running')
    void request<RelayTestResult>({ method: 'remote.relayTest' })
      .then(setRelayChecked)
      .catch(() => setRelayChecked({ ok: false, cause: 'relayUnreachable' }))
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

      {tab.offered && (
        <div className="card">
          <h3>{t('remote.wizard.transport')}</h3>
          <div role="radiogroup" aria-label={t('remote.wizard.transport')}>
            <label className="row">
              <input type="radio" name="remote-transport" checked={!tab.viaRelay} onChange={() => void patch({ transport: 'tailscale' })} />{' '}
              {t('remote.wizard.transport.tailscale')}
            </label>
            <label className="row">
              <input
                type="radio"
                name="remote-transport"
                aria-label={t('remote.relay.enable')}
                checked={tab.viaRelay}
                onChange={() => void patch({ transport: 'relay' })}
              />{' '}
              {t('remote.wizard.transport.relay')}
            </label>
          </div>
          {/* The three notices come before the native dialog the choice opens (spec 027 AC-6.4). */}
          <h4>{t('remote.relay.title')}</h4>
          {!tab.viaRelay && <p className="muted small">{t('remote.relay.off.hint')}</p>}
          <ul className="muted small remote-notices">
            <li>{t('remote.relay.sees')}</li>
            <li>{t('remote.relay.notice.shell')}</li>
            <li>{t('remote.relay.notice.operator', { contact: ABUSE_CONTACT })}</li>
          </ul>
        </div>
      )}

      {config.enabled && (
        <div className="card">
          <h3>
            <span className={`badge ${STATUS_BADGE[status.state]}`}>{t(`channels.state.${status.state}`)}</span>
          </h3>
          {cause && <p className="muted small">{cause}</p>}
          {status.address && <p className="muted small">{status.address}</p>}
          {!tab.viaRelay && status.keyExpiresInDays !== undefined && status.keyExpiresInDays < 14 && (
            <p className="text-warn small">{t('remote.wizard.keyExpiry', { count: status.keyExpiresInDays })}</p>
          )}
          {!tab.viaRelay && status.renamed && (
            <>
              <p className="text-warn small">{t('remote.wizard.renamed')}</p>
              <button type="button" onClick={revokeOld}>
                {t('remote.wizard.renamed.revoke')}
              </button>
            </>
          )}
          {tab.renamed && (
            <>
              <p className="text-warn small">{t('remote.relay.renamed')}</p>
              <button type="button" onClick={revokeOld}>
                {t('remote.relay.renamed.revoke')}
              </button>
            </>
          )}
          {tab.canTest && (
            <div className="remote-actions">
              <button type="button" disabled={relayChecked === 'running'} onClick={testRelay}>
                {t('remote.wizard.relay.test')}
              </button>
              {relayChecked === 'running' && <p className="muted small">{t('remote.relay.test.running')}</p>}
              {typeof relayChecked === 'object' && relayChecked.ok && <p className="muted small">{t('remote.wizard.test.ok')}</p>}
              {typeof relayChecked === 'object' && !relayChecked.ok && <p className="text-warn small">{testCauseText(t, relayChecked.cause, status.detail)}</p>}
            </div>
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

      {config.enabled && (tab.viaRelay ? tab.canPair : step === 'pair' || step === 'ready') && <PairingCard pairing={pairing} />}
      {config.enabled && <DevicesCard devices={devices} tested={tested} note={tab.devicesNote ? t('remote.relay.devices.note') : undefined} />}
      {config.enabled && <ScopesCard settings={settings} onChange={onChange} />}
      {config.enabled && <ActivityCard activity={activity} />}
    </>
  )
}
