// The paired phones (T38): last seen, dormant badge, test, revoke, revoke all.
import { formatDateTime } from '../../../shared/i18n/format'
import type { DeviceView } from '../../../shared/types'
import { useLanguage, useT } from '../i18n/useT'
import { request } from '../lib/coordinator'

interface Props {
  devices: DeviceView[]
  tested: { deviceId: string; ok: boolean } | null
}

export function DevicesCard({ devices, tested }: Props): React.JSX.Element {
  const t = useT()
  const language = useLanguage()

  const revoke = (device: DeviceView): void => {
    if (!confirm(t('remote.devices.revoke.confirm', { name: device.name }))) return
    void request({ method: 'remote.revoke', deviceId: device.id }).catch(() => undefined)
  }
  const revokeAll = (): void => {
    // The native confirmation is main's (AC-6.5); a cancel answers { ok: false }.
    void request({ method: 'remote.revokeAll' }).catch(() => undefined)
  }
  const test = (deviceId: string): void => {
    void request<string | null>({ method: 'remote.test', deviceId }).catch(() => undefined)
  }

  return (
    <div className="card">
      <h3>{t('remote.devices.title')}</h3>
      {devices.length === 0 && <p className="muted small">{t('remote.devices.none')}</p>}
      <ul className="remote-devices">
        {devices.map((device) => (
          <li key={device.id}>
            <div>
              <strong>{device.name}</strong>
              {device.dormant && <span className="badge remote-dormant">{t('remote.devices.dormant')}</span>}
              {device.lastSeen !== null && (
                <span className="muted small"> · {t('remote.devices.lastSeen', { when: formatDateTime(language, device.lastSeen, 'short') })}</span>
              )}
              {tested?.deviceId === device.id && (
                <span className="muted small"> · {tested.ok ? t('remote.wizard.test.ok') : t('remote.wizard.fail.phoneSilent')}</span>
              )}
            </div>
            <div className="remote-actions">
              <button type="button" onClick={() => test(device.id)}>{t('remote.devices.test')}</button>
              <button type="button" onClick={() => revoke(device)}>{t('remote.devices.revoke')}</button>
            </div>
          </li>
        ))}
      </ul>
      {devices.length > 0 && (
        <button type="button" onClick={revokeAll}>{t('remote.devices.revokeAll')}</button>
      )}
    </div>
  )
}
