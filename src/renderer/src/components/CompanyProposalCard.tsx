import { TriangleAlert } from 'lucide-react'
import { COMPANY_COLORS } from '../../../shared/company'
import type { CompanyProposalView } from '../../../shared/companyAuthoring'
import { useT, type T } from '../i18n/useT'
import { Icon } from '../umbra/Icon'

type Position = CompanyProposalView['positions'][number]

function Names({ names, t }: { names: string[]; t: T }): React.JSX.Element {
  if (!names.length) return <span className="muted small">{t('company.proposal.none')}</span>
  return (
    <span className="row">
      {names.map((name, index) => (
        <span key={`${index}:${name}`} className="badge">{name}</span>
      ))}
    </span>
  )
}

function PositionRow({ position, t }: { position: Position; t: T }): React.JSX.Element {
  return (
    <details className="proposal-position" open>
      <summary className="row">
        <strong className="ellipsis" title={position.title}>{position.title}</strong>
        <span className="muted small ellipsis" title={position.boss ?? undefined}>
          {position.boss === null ? t('company.proposal.reportsToBoard') : t('company.proposal.reportsTo', { boss: position.boss })}
        </span>
        {position.runsCommandsUnasked && (
          <span className="badge danger row" role="note">
            <Icon icon={TriangleAlert} size={14} />
            {t('company.proposal.runsCommands')}
          </span>
        )}
      </summary>
      {/* Everything below is model-written: text nodes and <pre>, never markdown or HTML. */}
      {position.description && (
        <>
          <div className="detail-label">{t('company.proposal.description')}</div>
          <div className="subagent-task">{position.description}</div>
        </>
      )}
      <div className="detail-label">{t('company.proposal.instructions')}</div>
      <pre className="code">{position.instructions}</pre>
      <div className="detail-label">{t('company.proposal.tools')}</div>
      <Names names={position.tools} t={t} />
      <div className="detail-label">{t('company.proposal.autoApprove')}</div>
      <Names names={position.autoApprove} t={t} />
      <div className="row small muted proposal-flags">
        <span>{position.canDelegate ? t('company.proposal.canDelegate') : t('company.proposal.cannotDelegate')}</span>
        <span>{position.allowMcp ? t('company.proposal.mcpOn') : t('company.proposal.mcpOff')}</span>
        {position.budgetUsd > 0 && <span>{t('company.proposal.memberBudget', { amount: position.budgetUsd })}</span>}
      </div>
    </details>
  )
}

/** Read-only: the rows come ready-made from `proposalOfCreation`, and Permitir / Rechazar live in ToolCard. */
export function CompanyProposalCard({ proposal }: { proposal: CompanyProposalView }): React.JSX.Element {
  const t = useT()
  return (
    <div className="company-proposal">
      <div className="detail-label">{t('company.proposal.company')}</div>
      <div className="proposal-text">{proposal.company}</div>
      {proposal.mission && (
        <>
          <div className="detail-label">{t('company.proposal.mission')}</div>
          <div className="proposal-text">{proposal.mission}</div>
        </>
      )}
      {proposal.goals && (
        <>
          <div className="detail-label">{t('company.proposal.goals')}</div>
          <div className="proposal-text">{proposal.goals}</div>
        </>
      )}
      <div className="detail-label">{t('company.proposal.color')}</div>
      <div className="row">
        {/* The style only ever gets a palette colour: anything else is shown as text alone. */}
        {COMPANY_COLORS.includes(proposal.color) && <span className="proposal-swatch" style={{ background: proposal.color }} aria-hidden="true" />}
        <span className="mono">{proposal.color}</span>
      </div>
      {proposal.vault && (
        <>
          <div className="detail-label">{t('company.proposal.vault')}</div>
          <div className="proposal-text mono">{proposal.vault}</div>
        </>
      )}
      {proposal.budgetUsd !== undefined && (
        <>
          <div className="detail-label">{t('company.proposal.budget')}</div>
          <div>{`USD ${proposal.budgetUsd}`}</div>
        </>
      )}
      <div className="detail-label">{t('company.proposal.positions', { count: proposal.positions.length })}</div>
      <div className="proposal-positions" tabIndex={0}>
        {proposal.positions.map((position, index) => (
          <PositionRow key={`${index}:${position.title}`} position={position} t={t} />
        ))}
      </div>
      {proposal.briefHeaderAdded && <div className="small muted">{t('company.proposal.briefHeader')}</div>}
      <div className="small muted">{t('company.proposal.readOnly')}</div>
    </div>
  )
}
