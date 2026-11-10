// One approval card (T43): question, reason, tool and input, allow and deny only.
import { Check, X } from 'lucide-react'
import type { ApprovalView } from '../../shared/remote/api'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import { approvalActions, approvalQuestionKey } from '../lib/chat'

interface Props {
  approval: ApprovalView
  language: PwaLanguage
  onAnswer(id: string, decision: 'allow' | 'deny'): void
}

export function ApprovalCard({ approval, language, onAnswer }: Props): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const { allow, notice } = approvalActions(approval)
  return (
    <section className="pwa-card">
      <p>{t(approvalQuestionKey(approval.question))}</p>
      {approval.reason && <p className="pwa-muted">{approval.reason}</p>}
      <p className="pwa-muted">{approval.tool}</p>
      {approval.input && <pre className="pwa-input">{approval.input}</pre>}
      {notice && <p className="pwa-muted" role="note">{t(notice)}</p>}
      <div className="pwa-actions">
        {allow && (
          <button type="button" className="primary" onClick={() => onAnswer(approval.id, 'allow')}>
            <Check size={20} strokeWidth={1.75} aria-hidden="true" />
            {t('remote.pwa.allow')}
          </button>
        )}
        <button type="button" className="danger" onClick={() => onAnswer(approval.id, 'deny')}>
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
          {t('remote.pwa.deny')}
        </button>
      </div>
    </section>
  )
}
