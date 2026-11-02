import { Crown, Link2 } from 'lucide-react'
import { useState } from 'react'
import { canReportTo } from '../../../shared/company'
import type { AgentProfile, Company, CompanyMember } from '../../../shared/types'
import { Icon } from '../umbra/Icon'

interface Props {
  company: Company
  agents: AgentProfile[]
  /** Members working right now (glow). */
  working?: string[]
  /** Spend this month by member (USD). */
  spend?: Record<string, number>
  selected?: string | null
  onSelect?(memberId: string | null): void
  /** Editing: drop a position on another to make it report there (null = straight to the board). */
  onReparent?(memberId: string, boss: string | null): void
}

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')

/**
 * The org chart as a tree: the board (the user) on top, each position under its boss. Dotted lines (who collaborates
 * with whom) show as chips on the card. In edit mode, positions are dragged onto their new boss.
 */
export function OrgChart({ company, agents, working = [], spend, selected, onSelect, onReparent }: Props): React.JSX.Element {
  const [dropOn, setDropOn] = useState<string | null>(null)
  const name = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  const childrenOf = (boss: string | null): CompanyMember[] => company.members.filter((m) => m.reportsTo === boss || (boss === null && m.reportsTo !== null && !company.members.some((x) => x.id === m.reportsTo)))
  const dragging = (e: React.DragEvent): string => e.dataTransfer.getData('text/x-alma-member')

  const dropProps = (target: string | null) =>
    onReparent
      ? {
          onDragOver: (e: React.DragEvent) => {
            e.preventDefault()
            setDropOn(target ?? 'board')
          },
          onDragLeave: () => setDropOn((d) => (d === (target ?? 'board') ? null : d)),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault()
            setDropOn(null)
            const member = dragging(e)
            if (member && member !== target && canReportTo(company, member, target)) onReparent(member, target)
          }
        }
      : {}

  const node = (member: CompanyMember): React.JSX.Element => {
    const agentName = name(member.id)
    const busy = working.includes(member.id)
    const kids = childrenOf(member.id)
    return (
      <li key={member.id}>
        <div
          className={`org-card${selected === member.id ? ' selected' : ''}${busy ? ' busy' : ''}${dropOn === member.id ? ' drop' : ''}`}
          role="button"
          tabIndex={0}
          draggable={!!onReparent}
          onDragStart={(e) => e.dataTransfer.setData('text/x-alma-member', member.id)}
          onClick={() => onSelect?.(selected === member.id ? null : member.id)}
          onKeyDown={(e) => e.key === 'Enter' && onSelect?.(member.id)}
          style={{ '--company': company.color } as React.CSSProperties}
          title={busy ? `${agentName} está trabajando` : agentName}
          {...dropProps(member.id)}
        >
          <span className="org-avatar" aria-hidden>
            {initials(agentName)}
          </span>
          <span className="org-text">
            <strong className="ellipsis">{agentName}</strong>
            <span className="small muted ellipsis">{member.title}</span>
            {spend && <span className="small muted">USD {(spend[member.id] ?? 0).toFixed(2)}{member.budgetUsd ? ` / ${member.budgetUsd}` : ''}</span>}
          </span>
          {member.collaborates.length > 0 && (
            <span className="org-links" title={`Colabora con ${member.collaborates.map(name).join(', ')}`}>
              <Icon icon={Link2} size={12} /> {member.collaborates.length}
            </span>
          )}
        </div>
        {kids.length > 0 && <ul>{kids.map(node)}</ul>}
      </li>
    )
  }

  return (
    <div className="org-chart">
      <ul>
        <li>
          <div className={`org-card board${dropOn === 'board' ? ' drop' : ''}`} {...dropProps(null)}>
            <span className="org-avatar" aria-hidden>
              <Icon icon={Crown} size={16} />
            </span>
            <span className="org-text">
              <strong>Directorio</strong>
              <span className="small muted">Vos: aprobás y decidís</span>
            </span>
          </div>
          {company.members.length > 0 && <ul>{childrenOf(null).map(node)}</ul>}
        </li>
      </ul>
      {onReparent && <p className="small muted org-hint">Arrastrá un puesto sobre otro para cambiar a quién le reporta.</p>}
    </div>
  )
}
