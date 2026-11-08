// Pairing from the PC (T38): start, scan the QR, compare the 6-digit code, name and approve.
import { Check, QrCode, X } from 'lucide-react'
import { useState } from 'react'
import { OFFER_EXPIRES_MS, PAIRING_LOCK_MS } from '../../../shared/remote/pairing'
import type { PairApproveResult, PairingView, PairStartResult } from '../../../shared/types'
import { Logo } from '../components/Logo'
import { useT } from '../i18n/useT'
import { request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'

const minutesLeft = (until: number | undefined, full: number): number =>
  until === undefined ? full : Math.max(1, Math.ceil((until - Date.now()) / 60_000))

export function PairingCard({ pairing }: { pairing: PairingView | null }): React.JSX.Element {
  const t = useT()
  const [name, setName] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const startFailure = (reason: Extract<PairStartResult, { ok: false }>['reason']): void => {
    // 'off' and 'no-host' cannot happen here: the card only shows while enabled and serving.
    if (reason === 'busy') setFailure(t('remote.pair.busy'))
    else if (reason === 'limit') setFailure(t('remote.pair.limit'))
    else if (reason === 'locked') setFailure(t('remote.pair.locked', { minutes: PAIRING_LOCK_MS / 60_000 }))
  }

  const approveFailure = (reason: Extract<PairApproveResult, { ok: false }>['reason']): void => {
    // 'denied' is the person cancelling the native dialog: silence, not an error.
    // 'invalid' cannot happen: the button needs a name and a live request.
    // 'mismatch' (the phone proved a wrong code) also starts over, like an expiry.
    if (reason === 'expired' || reason === 'mismatch') setFailure(t('remote.pair.expired'))
    else if (reason === 'locked') setFailure(t('remote.pair.locked', { minutes: PAIRING_LOCK_MS / 60_000 }))
    else if (reason === 'limit') setFailure(t('remote.pair.limit'))
  }

  const start = (): void => {
    setFailure(null)
    void request<PairStartResult>({ method: 'remote.pair.start' })
      .then((result) => {
        if (!result.ok) startFailure(result.reason)
      })
      .catch(() => undefined)
  }
  const approve = (): void => {
    if (!name.trim() || pairing?.stage !== 'request') return
    setFailure(null)
    void request<PairApproveResult>({ method: 'remote.pair.approve', name: name.trim() })
      .then((result) => {
        if (result.ok) setName('')
        else approveFailure(result.reason)
      })
      .catch(() => undefined)
  }
  const reject = (): void => {
    setFailure(null)
    setName('')
    void request({ method: 'remote.pair.reject' }).catch(() => undefined)
  }
  const cancel = (): void => {
    setFailure(null)
    setName('')
    void request({ method: 'remote.pair.cancel' }).catch(() => undefined)
  }

  return (
    <div className="card">
      <div className="remote-pair-head">
        <Logo size={28} />
        <h3>{t('remote.pair.title')}</h3>
      </div>
      {!pairing && !failure && (
        <button type="button" className="primary" onClick={start}>
          <Icon icon={QrCode} size="sm" />
          {t('remote.pair.title')}
        </button>
      )}
      {pairing?.stage === 'offer' && (
        <>
          {pairing.qrDataUrl && (
            <div className="remote-qr-wrap">
              <img className="remote-qr" src={pairing.qrDataUrl} alt="" />
            </div>
          )}
          <p className="muted small">{t('remote.pair.qr.hint', { minutes: minutesLeft(pairing.expiresAt, OFFER_EXPIRES_MS / 60_000) })}</p>
          <button type="button" className="ghost" onClick={cancel}>{t('common.cancel')}</button>
        </>
      )}
      {pairing?.stage === 'request' && (
        <>
          <p className="remote-code">{t('remote.pair.code.compare', { code: pairing.code ?? '' })}</p>
          <label className="row">
            {t('remote.pair.name')}
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </label>
          <div className="remote-actions">
            <button type="button" className="primary" disabled={!name.trim()} onClick={approve}>
              <Icon icon={Check} size="sm" />
              {t('remote.pair.approve')}
            </button>
            <button type="button" className="ghost" onClick={reject}>
              <Icon icon={X} size="sm" />
              {t('remote.pair.reject')}
            </button>
          </div>
        </>
      )}
      {pairing?.stage === 'locked' && (
        <p className="muted small">{t('remote.pair.locked', { minutes: minutesLeft(pairing.lockedUntil, PAIRING_LOCK_MS / 60_000) })}</p>
      )}
      {failure && (
        <>
          <p className="text-warn small">{failure}</p>
          <button type="button" className="primary" onClick={start}>{t('remote.pair.title')}</button>
        </>
      )}
    </div>
  )
}
