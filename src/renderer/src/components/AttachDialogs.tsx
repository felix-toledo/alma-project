import { ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { planSeeProvider } from '../../../shared/attach/readers'
import { looksLikeApiKey, PROVIDER_NAMES } from '../../../shared/defaults'
import { hasSeeRule } from '../../../shared/images/models'
import type { ProviderId, Settings } from '../../../shared/types'
import { useT } from '../i18n/useT'
import { FocusScope, useBack } from '../umbra/FocusManager'
import { Icon } from '../umbra/Icon'

interface FrameProps {
  id: string
  title: string
  onClose(): void
  children: React.ReactNode
}

// Cancel comes first in the DOM, so it is what the focus lands on: the safe answer is the default one.
function Frame({ id, title, onClose, children }: FrameProps): React.JSX.Element {
  useBack(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <FocusScope id={id} trap>
        <div className="modal small-modal" role="dialog" aria-modal="true" aria-label={title}>
          <header className="modal-header">
            <h2>
              <Icon icon={ShieldAlert} size="sm" /> {title}
            </h2>
          </header>
          <div className="modal-pad">{children}</div>
        </div>
      </FocusScope>
    </div>
  )
}

/** A file whose name looks like it holds a secret (AC-3.2): a warning the person can override, never a refusal. The name is plain text. */
export function SecretNameDialog({ name, onChoose }: { name: string; onChoose(attachAnyway: boolean): void }): React.JSX.Element {
  const t = useT()
  return (
    <Frame id="attach-secret" title={t('attach.secret.title')} onClose={() => onChoose(false)}>
      <p>{t('attach.secret.body', { name })}</p>
      <div className="row end">
        <button type="button" className="ghost" onClick={() => onChoose(false)}>
          {t('common.cancel')}
        </button>
        <button type="button" className="primary" onClick={() => onChoose(true)}>
          {t('attach.secret.confirm')}
        </button>
      </div>
    </Frame>
  )
}

/** Shown at send, once per provider (AC-3.1): the attached content goes to the providers that will read it. */
export function ProviderNoticeDialog({ providers, onChoose }: { providers: readonly ProviderId[]; onChoose(send: boolean): void }): React.JSX.Element {
  const t = useT()
  return (
    <Frame id="attach-notice" title={t('attach.notice.title')} onClose={() => onChoose(false)}>
      <p>{t('attach.notice.body', { providers: providers.map((p) => PROVIDER_NAMES[p]).join(', ') })}</p>
      <p className="small muted">{t('attach.notice.once')}</p>
      <div className="row end">
        <button type="button" className="ghost" onClick={() => onChoose(false)}>
          {t('common.cancel')}
        </button>
        <button type="button" className="primary" onClick={() => onChoose(true)}>
          {t('attach.notice.send')}
        </button>
      </div>
    </Frame>
  )
}

/**
 * Choosing a provider to look at pictures (spec 038 AC-4.8, AC-4.9). Confirm saves the provider, the typed model and the acknowledgement in one
 * patch; Cancel saves nothing. A provider with no known seeing model (G5) cannot be confirmed until one is typed. It is portaled to the body
 * because the settings modal blurs and clips whatever is `position: fixed` inside it, and it takes Escape for itself so it does not also close Settings.
 */
export function SeeProviderDialog({
  provider,
  initialModel = '',
  settings,
  onConfirm,
  onCancel
}: {
  provider: ProviderId
  /** A model already typed in the Images tab: Confirm saves it with the acknowledgement. */
  initialModel?: string
  settings: Pick<Settings, 'images' | 'attachments'>
  onConfirm(patch: ReturnType<typeof planSeeProvider>['patch']): void
  onCancel(): void
}): React.JSX.Element {
  const t = useT()
  const [model, setModel] = useState(initialModel)
  const plan = planSeeProvider(settings, provider, model)
  const isKey = looksLikeApiKey(model)
  const name = PROVIDER_NAMES[provider]
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  return createPortal(
    <Frame id="see-provider" title={t('images.see.confirm.title', { provider: name })} onClose={onCancel}>
      <p>{t('images.see.confirm.body', { provider: name })}</p>
      {!hasSeeRule(provider) && (
        <>
          <p className="small muted">{t('images.see.autoNone', { provider: name })}</p>
          <label className="field">
            <span>{t('images.see.confirm.model')}</span>
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          {isKey && <span className="text-danger small">{t('images.isKey')}</span>}
        </>
      )}
      <div className="row end">
        <button type="button" className="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button type="button" className="primary" disabled={plan.needsModel || isKey} onClick={() => onConfirm(plan.patch)}>
          {t('images.see.confirm.accept')}
        </button>
      </div>
    </Frame>,
    document.body
  )
}
