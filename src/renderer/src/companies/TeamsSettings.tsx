import { Building2, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { canReportTo, companyTemplates, memberAgent, newId, pickName } from '../../../shared/company'
import { BUILTIN_TOOLS, CLAUDE_MODELS, emailServersFor, PROVIDER_NAMES } from '../../../shared/defaults'
import type { AgentProfile, Company, CompanyMember, Effort, ProviderId, PublicSettings, Routine, WhatsAppStatus } from '../../../shared/types'
import { onEvent, request } from '../lib/coordinator'
import { useLanguage, useT } from '../i18n/useT'
import { toolLabel } from '../lib/format'
import { Icon } from '../umbra/Icon'
import { OrgChart } from './OrgChart'
import './companies.css'

interface Props {
  settings: PublicSettings
  onChange(patch: Partial<PublicSettings>): Promise<void>
  onSettingsReplaced(settings: PublicSettings): void
}

const COLORS = ['#8b5cf6', '#10b981', '#0ea5e9', '#f59e0b', '#ef4444', '#ec4899', '#14b8a6', '#6366f1']
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const EMPTY_EMAIL = { address: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 465 }

async function defaultCompanyVault(name: string): Promise<string> {
  const base = await window.desktop.defaultVaultPath()
  const root = base.replace(/[\\/][^\\/]+$/, '')
  return `${root}\\Empresas\\${name.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Empresa'}`
}

export function TeamsSettings({ settings, onChange, onSettingsReplaced }: Props): React.JSX.Element {
  const t = useT()
  const [selected, setSelected] = useState<string | null>(settings.companies[0]?.id ?? null)
  const [creating, setCreating] = useState(settings.companies.length === 0)
  const company = settings.companies.find((c) => c.id === selected) ?? null

  const saveCompany = (next: Company, agents?: AgentProfile[]): Promise<void> =>
    onChange({ companies: settings.companies.map((c) => (c.id === next.id ? next : c)), ...(agents ? { agents } : {}) })

  return (
    <div className="teams">
      <div className="card">
        <div className="row space">
          <h3>{t('common.companies')}</h3>
          <button className="primary small" onClick={() => setCreating(true)}>
            <Icon icon={Plus} size={14} /> {t('teams.new')}
          </button>
        </div>
        <p className="muted small">
          {t('teams.intro')}
        </p>
        <div className="row wrap">
          {settings.companies.map((c) => (
            <button key={c.id} className={`company-chip${c.id === selected ? ' active' : ''}`} style={{ '--company': c.color } as React.CSSProperties} onClick={() => (setSelected(c.id), setCreating(false))}>
              <span className="company-dot" aria-hidden /> {c.name} <span className="muted small">{c.members.length}</span>
            </button>
          ))}
        </div>
      </div>
      {creating ? (
        <NewCompany
          settings={settings}
          onCancel={settings.companies.length ? () => setCreating(false) : undefined}
          onCreate={async (next, agents) => {
            await request({ method: 'vault.init', path: next.vault })
            await onChange({ companies: [...settings.companies, next], agents: [...settings.agents, ...agents], vaults: [...new Set([...settings.vaults, next.vault])] })
            setSelected(next.id)
            setCreating(false)
          }}
        />
      ) : company ? (
        <CompanyEditor key={company.id} company={company} settings={settings} onSave={saveCompany} onChange={onChange} onSettingsReplaced={onSettingsReplaced} onDeleted={() => setSelected(null)} />
      ) : null}
    </div>
  )
}

function NewCompany({ settings, onCreate, onCancel }: { settings: PublicSettings; onCreate(company: Company, agents: AgentProfile[]): Promise<void>; onCancel?(): void }): React.JSX.Element {
  const tr = useT()
  const templates = companyTemplates(useLanguage())
  const [template, setTemplate] = useState(templates[0].id)
  const [name, setName] = useState('')
  const [vault, setVault] = useState('')
  const [vaultTouched, setVaultTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const chosen = templates.find((t) => t.id === template)
  const finalName = name.trim() || chosen?.name || tr('teams.defaultName')

  useEffect(() => {
    if (!vaultTouched) void defaultCompanyVault(finalName).then(setVault)
  }, [finalName, vaultTouched])

  const create = async (): Promise<void> => {
    setBusy(true)
    const company: Company = {
      id: newId('empresa'),
      name: finalName,
      mission: chosen?.mission ?? '',
      goals: chosen?.goals ?? '',
      vault,
      color: chosen?.color ?? COLORS[settings.companies.length % COLORS.length],
      budgetUsd: 20,
      members: [],
      email: { ...EMPTY_EMAIL },
      whatsapp: false,
      createdAt: Date.now()
    }
    const ids = new Map<string, string>()
    const agents: AgentProfile[] = []
    const start = settings.companies.length * 5
    for (const t of chosen?.members ?? []) {
      const id = newId('puesto')
      ids.set(t.key, id)
      company.members.push({ id, title: t.title, reportsTo: null, collaborates: [], budgetUsd: 0 })
      agents.push(memberAgent(company, company.members[company.members.length - 1], t, pickName(agents.map((a) => a.name), start)))
    }
    // Bosses are known once every position has an id.
    for (const [i, t] of (chosen?.members ?? []).entries()) company.members[i].reportsTo = t.reportsTo ? (ids.get(t.reportsTo) ?? null) : null
    try {
      await onCreate(company, agents)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card">
      <h3>{tr('teams.new')}</h3>
      <div className="template-grid">
        {templates.map((t) => (
          <button key={t.id} className={`template${template === t.id ? ' active' : ''}`} style={{ '--company': t.color } as React.CSSProperties} onClick={() => setTemplate(t.id)}>
            <Icon icon={Building2} size={18} />
            <strong>{t.name}</strong>
            <span className="small muted">{t.members.map((m) => m.title).join(' · ')}</span>
          </button>
        ))}
        <button className={`template${template === 'blank' ? ' active' : ''}`} onClick={() => setTemplate('blank')}>
          <Icon icon={Plus} size={18} />
          <strong>{tr('teams.blank')}</strong>
          <span className="small muted">{tr('teams.blankHint')}</span>
        </button>
      </div>
      <label className="field">
        <span>{tr('common.name')}</span>
        <input value={name} placeholder={chosen?.name ?? tr('teams.defaultName')} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span>{tr('teams.vaultLabel')}</span>
        <div className="row">
          <input className="grow" value={vault} onChange={(e) => (setVault(e.target.value), setVaultTouched(true))} />
          <button
            className="ghost"
            onClick={async () => {
              const folder = await window.desktop.pickFolder()
              if (folder) (setVault(folder), setVaultTouched(true))
            }}
          >
            {tr('chat.pickFolder')}
          </button>
        </div>
      </label>
      <div className="row end">
        {onCancel && (
          <button className="ghost" onClick={onCancel}>
            {tr('common.cancel')}
          </button>
        )}
        <button className="primary" disabled={busy || !vault} onClick={() => void create()}>
          {busy ? tr('teams.creating') : tr('teams.createCompany')}
        </button>
      </div>
    </div>
  )
}

function CompanyEditor({
  company,
  settings,
  onSave,
  onChange,
  onSettingsReplaced,
  onDeleted
}: {
  company: Company
  settings: PublicSettings
  onSave(company: Company, agents?: AgentProfile[]): Promise<void>
  onChange(patch: Partial<PublicSettings>): Promise<void>
  onSettingsReplaced(settings: PublicSettings): void
  onDeleted(): void
}): React.JSX.Element {
  const t = useT()
  const [member, setMember] = useState<string | null>(null)
  const patch = (next: Partial<Company>): Promise<void> => onSave({ ...company, ...next })
  const agents = settings.agents

  const reparent = (memberId: string, boss: string | null): void => {
    if (!canReportTo(company, memberId, boss)) return
    void patch({ members: company.members.map((m) => (m.id === memberId ? { ...m, reportsTo: boss } : m)) })
  }

  const addMember = (): void => {
    const id = newId('puesto')
    const boss = member ?? company.members.find((m) => m.reportsTo === null)?.id ?? null
    const next: CompanyMember = { id, title: t('teams.newPosition.title'), reportsTo: boss, collaborates: [], budgetUsd: 0 }
    const taken = agents.filter((a) => a.companyId === company.id).map((a) => a.name)
    const agent = memberAgent(company, next, { description: t('teams.newPosition.description'), instructions: t('teams.newPosition.instructions'), tools: ['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file'], canDelegate: false }, pickName(taken))
    void onSave({ ...company, members: [...company.members, next] }, [...agents, agent]).then(() => setMember(id))
  }

  const removeCompany = (): void => {
    if (!confirm(t('teams.deleteConfirm', { name: company.name, count: company.members.length }))) return
    const ids = new Set(company.members.map((m) => m.id))
    void onChange({
      companies: settings.companies.filter((c) => c.id !== company.id),
      agents: agents.filter((a) => !ids.has(a.id)),
      routines: settings.routines.filter((r) => !ids.has(r.agentId))
    }).then(onDeleted)
  }

  return (
    <>
      <div className="card">
        <div className="row space">
          <h3>{company.name}</h3>
          <button className="ghost small danger-text" onClick={removeCompany}>
            <Icon icon={Trash2} size={14} /> {t('teams.deleteCompany')}
          </button>
        </div>
        <div className="row">
          <label className="field grow">
            <span>{t('common.name')}</span>
            <input value={company.name} onChange={(e) => void patch({ name: e.target.value })} />
          </label>
          <label className="field">
            <span>{t('teams.color')}</span>
            <div className="row">
              {COLORS.map((color) => (
                <button key={color} className={`swatch${company.color === color ? ' active' : ''}`} style={{ background: color }} title={color} aria-label={t('teams.colorAria', { color })} onClick={() => void patch({ color })} />
              ))}
            </div>
          </label>
        </div>
        <label className="field">
          <span>{t('teams.mission')}</span>
          <textarea rows={2} value={company.mission} onChange={(e) => void patch({ mission: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('teams.goals')}</span>
          <textarea rows={3} value={company.goals} onChange={(e) => void patch({ goals: e.target.value })} />
        </label>
        <div className="row">
          <label className="field grow">
            <span>{t('sidebar.mode.vault')}</span>
            <div className="row">
              <input className="grow" value={company.vault} onChange={(e) => void patch({ vault: e.target.value })} />
              <button
                className="ghost"
                onClick={async () => {
                  const folder = await window.desktop.pickFolder()
                  if (folder) void onChange({ companies: settings.companies.map((c) => (c.id === company.id ? { ...c, vault: folder } : c)), vaults: [...new Set([...settings.vaults, folder])] })
                }}
              >
                {t('voice.eleven.choose')}
              </button>
            </div>
          </label>
          <label className="field">
            <span>{t('teams.budget')}</span>
            <input type="number" min={0} value={company.budgetUsd} onChange={(e) => void patch({ budgetUsd: Math.max(0, Number(e.target.value)) })} />
          </label>
        </div>
      </div>

      <div className="card">
        <div className="row space">
          <h3>{t('companies.tab.org')}</h3>
          <button className="primary small" onClick={addMember} title={member ? t('teams.addPositionUnderSelected') : t('teams.addPositionUnderBoss')}>
            <Icon icon={Plus} size={14} /> {t('teams.addPosition')}
          </button>
        </div>
        <OrgChart company={company} agents={agents} selected={member} onSelect={setMember} onReparent={reparent} />
      </div>

      {member && company.members.some((m) => m.id === member) && (
        <MemberEditor key={member} company={company} memberId={member} settings={settings} onSave={onSave} onChange={onChange} onClose={() => setMember(null)} />
      )}

      <Accounts company={company} settings={settings} patch={patch} onSettingsReplaced={onSettingsReplaced} />
    </>
  )
}

function MemberEditor({
  company,
  memberId,
  settings,
  onSave,
  onChange,
  onClose
}: {
  company: Company
  memberId: string
  settings: PublicSettings
  onSave(company: Company, agents?: AgentProfile[]): Promise<void>
  onChange(patch: Partial<PublicSettings>): Promise<void>
  onClose(): void
}): React.JSX.Element {
  const t = useT()
  const member = company.members.find((m) => m.id === memberId)!
  const agent = settings.agents.find((a) => a.id === memberId)
  const [routine, setRoutine] = useState({ time: '09:00', prompt: t('teams.routine.prompt') })
  if (!agent) return <div className="card">{t('teams.noAgent')}</div>
  const others = company.members.filter((m) => m.id !== memberId)
  const name = (id: string): string => settings.agents.find((a) => a.id === id)?.name ?? id

  const saveMember = (next: Partial<CompanyMember>): Promise<void> => onSave({ ...company, members: company.members.map((m) => (m.id === memberId ? { ...m, ...next } : m)) })
  const saveAgent = (next: Partial<AgentProfile>): Promise<void> => onChange({ agents: settings.agents.map((a) => (a.id === memberId ? { ...a, ...next } : a)) })
  const routines = settings.routines.filter((r) => r.agentId === memberId)

  const remove = (): void => {
    if (!confirm(t('teams.removeConfirm', { title: member.title }))) return
    const members = company.members
      .filter((m) => m.id !== memberId)
      .map((m) => ({ ...m, reportsTo: m.reportsTo === memberId ? member.reportsTo : m.reportsTo, collaborates: m.collaborates.filter((id) => id !== memberId) }))
    void onChange({
      companies: settings.companies.map((c) => (c.id === company.id ? { ...c, members } : c)),
      agents: settings.agents.filter((a) => a.id !== memberId),
      routines: settings.routines.filter((r) => r.agentId !== memberId)
    }).then(onClose)
  }

  const addRoutine = (): void => {
    const next: Routine = {
      id: newId('rutina'),
      name: `${agent.name} · ${routine.time}`,
      agentId: memberId,
      workspace: company.vault,
      prompt: routine.prompt,
      schedule: { kind: 'daily', time: routine.time, days: [1, 2, 3, 4, 5] },
      enabled: true,
      createdAt: Date.now(),
      action: 'task'
    }
    void onChange({ routines: [...settings.routines, next] })
  }

  const tools = [...BUILTIN_TOOLS]
  return (
    <div className="card member-editor">
      <div className="row space">
        <h3>
          {agent.name} · {member.title}
        </h3>
        <div className="row">
          <button className="ghost small danger-text" onClick={remove}>
            <Icon icon={Trash2} size={14} /> {t('teams.removePosition')}
          </button>
          <button className="ghost small" onClick={onClose}>
            {t('teams.done')}
          </button>
        </div>
      </div>
      <div className="row">
        <label className="field grow">
          <span>{t('teams.agentName')}</span>
          <input value={agent.name} onChange={(e) => void saveAgent({ name: e.target.value })} />
        </label>
        <label className="field grow">
          <span>{t('teams.position')}</span>
          <input value={member.title} onChange={(e) => void saveMember({ title: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span>{t('teams.whatItDoes')}</span>
        <textarea rows={2} value={agent.description} onChange={(e) => void saveAgent({ description: e.target.value })} />
      </label>
      <label className="field">
        <span>{t('teams.instructions')}</span>
        <textarea rows={6} value={agent.systemPrompt} onChange={(e) => void saveAgent({ systemPrompt: e.target.value })} />
      </label>
      <div className="row">
        <label className="field">
          <span>{t('teams.reportsTo')}</span>
          <select value={member.reportsTo ?? ''} onChange={(e) => void saveMember({ reportsTo: e.target.value || null })}>
            <option value="">{t('teams.boardYou')}</option>
            {others
              .filter((m) => canReportTo(company, memberId, m.id))
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {name(m.id)} — {m.title}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>{t('teams.ownBudget')}</span>
          <input type="number" min={0} value={member.budgetUsd} onChange={(e) => void saveMember({ budgetUsd: Math.max(0, Number(e.target.value)) })} />
        </label>
      </div>
      <div className="field">
        <span>{t('teams.collaborates')}</span>
        <div className="row wrap">
          {others.map((m) => (
            <label key={m.id} className="check">
              <input
                type="checkbox"
                checked={member.collaborates.includes(m.id)}
                onChange={(e) => void saveMember({ collaborates: e.target.checked ? [...member.collaborates, m.id] : member.collaborates.filter((id) => id !== m.id) })}
              />
              {name(m.id)}
            </label>
          ))}
        </div>
      </div>
      <div className="row">
        <label className="field">
          <span>{t('agents.provider')}</span>
          <select value={agent.provider} onChange={(e) => void saveAgent({ provider: e.target.value as ProviderId, model: e.target.value === 'anthropic' ? CLAUDE_MODELS[0] : '' })}>
            {(Object.keys(PROVIDER_NAMES) as ProviderId[]).map((p) => (
              <option key={p} value={p}>
                {PROVIDER_NAMES[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>{t('teams.model')}</span>
          {agent.provider === 'anthropic' ? (
            <select value={agent.model} onChange={(e) => void saveAgent({ model: e.target.value })}>
              {CLAUDE_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input value={agent.model} onChange={(e) => void saveAgent({ model: e.target.value.trim() })} />
          )}
        </label>
        <label className="field">
          <span>{t('agents.effort')}</span>
          <select value={agent.effort} onChange={(e) => void saveAgent({ effort: e.target.value as Effort })}>
            {EFFORTS.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="field">
        <span>{t('teams.tools')}</span>
        <div className="row wrap">
          {tools.map((tool) => (
            <label key={tool} className="check">
              <input type="checkbox" checked={agent.tools.includes(tool)} onChange={(e) => void saveAgent({ tools: e.target.checked ? [...agent.tools, tool] : agent.tools.filter((t) => t !== tool) })} />
              {toolLabel(tool, t)}
            </label>
          ))}
        </div>
      </div>
      <div className="field">
        <span>{t('teams.routines')}</span>
        {routines.map((r) => (
          <div key={r.id} className="row space small">
            <span>
              {r.schedule.kind === 'daily' ? t('teams.weekdays', { time: r.schedule.time }) : r.name}: {r.prompt}
            </span>
            <button className="icon-button" title={t('common.remove')} onClick={() => void onChange({ routines: settings.routines.filter((x) => x.id !== r.id) })}>
              <Icon icon={Trash2} size={14} />
            </button>
          </div>
        ))}
        <div className="row">
          <input type="time" value={routine.time} onChange={(e) => setRoutine({ ...routine, time: e.target.value })} />
          <input className="grow" value={routine.prompt} onChange={(e) => setRoutine({ ...routine, prompt: e.target.value })} />
          <button className="ghost small" onClick={addRoutine}>
            {t('teams.addRoutine')}
          </button>
        </div>
      </div>
    </div>
  )
}

function Accounts({ company, settings, patch, onSettingsReplaced }: { company: Company; settings: PublicSettings; patch(next: Partial<Company>): Promise<void>; onSettingsReplaced(s: PublicSettings): void }): React.JSX.Element {
  const t = useT()
  const [password, setPassword] = useState('')
  const [status, setStatus] = useState<WhatsAppStatus>({ state: 'off' })
  const [test, setTest] = useState('')
  const email = company.email
  const hasPassword = settings.companyPasswords[company.id]

  useEffect(() => {
    void request<WhatsAppStatus>({ method: 'company.whatsapp.status', companyId: company.id }).then(setStatus)
    return onEvent((event) => {
      if (event.type === 'company.whatsapp' && event.companyId === company.id) setStatus(event.status)
    })
  }, [company.id, company.whatsapp])

  return (
    <div className="card">
      <h3>{t('teams.accounts')}</h3>
      <p className="muted small">{t('teams.accountsHint')}</p>
      <h4>{t('settings.tab.email')}</h4>
      <div className="row">
        <label className="field grow">
          <span>{t('email.address')}</span>
          <input type="email" value={email.address} placeholder="hola@empresa.com" onChange={(e) => void patch({ email: { ...email, address: e.target.value.trim() } })} onBlur={() => email.address.includes('@') && !email.imapHost && void patch({ email: { ...email, ...emailServersFor(email.address) } })} />
        </label>
        <label className="field grow">
          <span>{t('email.appPassword')}</span>
          <div className="row">
            <input type="password" className="grow" value={password} placeholder={hasPassword ? t('teams.saved') : ''} onChange={(e) => setPassword(e.target.value)} />
            <button className="primary small" disabled={!password.trim()} onClick={async () => (onSettingsReplaced(await window.desktop.settings.setCompanySecret(company.id, password.replace(/\s+/g, ''))), setPassword(''))}>
              {t('common.save')}
            </button>
          </div>
        </label>
      </div>
      {email.address && (
        <p className="small muted">
          {t('teams.servers', { imap: `${email.imapHost || '—'}:${email.imapPort}`, smtp: `${email.smtpHost || '—'}:${email.smtpPort}` })}{' '}
          <button className="link" onClick={() => void patch({ email: { ...email, ...emailServersFor(email.address) } })}>
            {t('teams.autofill')}
          </button>
          {test && <span> · {test}</span>}
        </p>
      )}
      <h4>{t('settings.tab.whatsapp')}</h4>
      <label className="check">
        <input type="checkbox" checked={company.whatsapp} onChange={(e) => void patch({ whatsapp: e.target.checked })} />
        {t('teams.ownNumber', { state: t(`channels.state.${status.state}`) })}
        {status.number ? ` · +${status.number}` : ''}
      </label>
      {status.state === 'qr' && status.qr && (
        <div className="row">
          <img src={status.qr} alt={t('teams.qrAlt')} width={200} height={200} style={{ background: '#fff', borderRadius: 8 }} />
          <p className="small">{t('teams.qrHint')}</p>
        </div>
      )}
      {status.state === 'error' && <p className="text-danger small">{status.error}</p>}
      {status.state === 'online' && (
        <button className="ghost small" onClick={() => void request({ method: 'company.whatsapp.logout', companyId: company.id }).then(() => setTest(''))}>
          {t('teams.unlink')}
        </button>
      )}
    </div>
  )
}
