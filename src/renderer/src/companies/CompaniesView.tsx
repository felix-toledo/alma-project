import { CalendarClock, MessageSquare, Network, Play, Plus, Send, Square, Trash2, Users, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Company, CompanyActor, CompanySnapshot, CompanyTask, Meeting, PendingApproval, PublicSettings, TaskStatus, Thread, ThreadSummary } from '../../../shared/types'
import { Markdown } from '../components/Markdown'
import { onEvent, request } from '../lib/coordinator'
import { formatDateTime } from '../../../shared/i18n/format'
import { useLanguage, useT } from '../i18n/useT'
import { relativeTime } from '../lib/format'
import { Icon } from '../umbra/Icon'
import { initials, OrgChart } from './OrgChart'
import './companies.css'

const COLUMNS: TaskStatus[] = ['todo', 'in_progress', 'review', 'blocked', 'done']

type Tab = 'board' | 'chats' | 'meetings' | 'org' | 'activity'

interface Props {
  settings: PublicSettings
  companyId: string | null
  /** Conversations with company agents (all companies); this view keeps the ones of its company. */
  threads: ThreadSummary[]
  activeId: string | null
  running: string[]
  approvals: PendingApproval[]
  /** The open conversation, already rendered, when it belongs to a company. */
  chat: React.ReactNode
  onDeleteThread(threadId: string): void
  onOpenThread(threadId: string): void
  onOpenSettings(): void
  /** Opens the company's vault in Conocimientos (to read minutes and documents). */
  onOpenVault(path: string, note?: string): void
}

function useSnapshot(companyId: string | null): { snapshot: CompanySnapshot | null; reload(): void } {
  const [snapshot, setSnapshot] = useState<CompanySnapshot | null>(null)
  const reload = useCallback(() => {
    if (!companyId) return setSnapshot(null)
    void request<CompanySnapshot>({ method: 'company.snapshot', companyId }).then(setSnapshot).catch(() => setSnapshot(null))
  }, [companyId])
  useEffect(() => {
    reload()
    return onEvent((event) => {
      if (event.type === 'company.changed' && event.companyId === companyId) reload()
    })
  }, [companyId, reload])
  return { snapshot, reload }
}

export function CompaniesView({ settings, companyId, threads, activeId, running, approvals, chat, onDeleteThread, onOpenThread: openThread, onOpenSettings, onOpenVault }: Props): React.JSX.Element {
  const tr = useT()
  const company = settings.companies.find((c) => c.id === companyId) ?? null
  const { snapshot } = useSnapshot(company?.id ?? null)
  const [tab, setTab] = useState<Tab>('board')
  // Opening any conversation (task, org chart, "Hablar con…") lands in this company's Chats tab.
  const onOpenThread = (threadId: string): void => {
    openThread(threadId)
    setTab('chats')
  }

  if (!company) {
    return (
      <main className="company-view empty-state">
        <h1>{tr('common.companies')}</h1>
        <p>{tr('companies.intro')}</p>
        <button className="primary" onClick={onOpenSettings}>
          <Icon icon={Plus} size="sm" /> {tr('companies.create')}
        </button>
      </main>
    )
  }

  const name = (actor: CompanyActor): string =>
    actor === 'user' ? tr('companies.board') : actor === 'system' ? tr('common.appName') : (settings.agents.find((a) => a.id === actor)?.name ?? company.members.find((m) => m.id === actor)?.title ?? actor)
  const spend = snapshot?.spend
  const ceo = company.members.find((m) => m.reportsTo === null) ?? company.members[0]

  const talkTo = async (memberId: string): Promise<void> => {
    const thread = await request<Thread>({ method: 'threads.create', agentId: memberId, workspace: company.vault })
    onOpenThread(thread.id)
  }

  return (
    <main className="company-view" style={{ '--company': company.color } as React.CSSProperties}>
      <header className="company-header">
        <div className="company-title">
          <span className="company-dot" aria-hidden />
          <div>
            <h2>{company.name}</h2>
            {company.mission && <p className="small muted ellipsis">{company.mission}</p>}
          </div>
        </div>
        <div className="row">
          {spend && (
            <span className={`badge${company.budgetUsd && spend.totalUsd >= company.budgetUsd * 0.8 ? ' warn' : ''}`} title={tr('companies.spendTitle')}>
              {tr('companies.spend', { total: spend.totalUsd.toFixed(2), budget: company.budgetUsd ? ` / ${company.budgetUsd}` : '' })}
            </span>
          )}
          {ceo && (
            <button className="ghost small" onClick={() => void talkTo(ceo.id)} title={tr('companies.talkToTitle')}>
              <Icon icon={MessageSquare} size={14} /> {tr('companies.talkTo', { name: settings.agents.find((a) => a.id === ceo.id)?.name ?? ceo.title })}
            </button>
          )}
          <button className="ghost small" onClick={() => onOpenVault(company.vault)} title={tr('companies.openVault')}>
            {tr('sidebar.mode.vault')}
          </button>
        </div>
      </header>
      <nav className="tabs company-tabs" role="tablist">
        {(
          [
            ['board', Square],
            ['chats', MessageSquare],
            ['meetings', Users],
            ['org', Network],
            ['activity', CalendarClock]
          ] as const
        ).map(([id, icon]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            <Icon icon={icon} size={14} /> {tr(`companies.tab.${id}`)}
          </button>
        ))}
      </nav>
      <section className="company-body">
        {!snapshot ? (
          <p className="muted pad">{tr('common.loading')}</p>
        ) : tab === 'board' ? (
          <Board company={company} snapshot={snapshot} settings={settings} name={name} onOpenThread={onOpenThread} />
        ) : tab === 'chats' ? (
          <Chats
            threads={threads.filter((t) => company.members.some((m) => m.id === t.agentId))}
            activeId={activeId}
            running={running}
            approvals={approvals}
            chat={chat}
            name={(id) => settings.agents.find((a) => a.id === id)?.name ?? id}
            onOpen={openThread}
            onDelete={onDeleteThread}
          />
        ) : tab === 'meetings' ? (
          <Meetings company={company} snapshot={snapshot} settings={settings} name={name} onOpenMinutes={(path) => onOpenVault(company.vault, path)} />
        ) : tab === 'org' ? (
          <div className="company-org">
            <OrgChart company={company} agents={settings.agents} working={snapshot.working} spend={spend?.byMember} onSelect={(id) => id && void talkTo(id)} />
            <p className="small muted">{tr('companies.orgHint')}</p>
          </div>
        ) : (
          <Activity snapshot={snapshot} name={name} />
        )}
      </section>
    </main>
  )
}

// ---------------------------------------------------------------------------

function Chats({ threads, activeId, running, approvals, chat, name, onOpen, onDelete }: {
  threads: ThreadSummary[]
  activeId: string | null
  running: string[]
  approvals: PendingApproval[]
  chat: React.ReactNode
  name(agentId: string): string
  onOpen(threadId: string): void
  onDelete(threadId: string): void
}): React.JSX.Element {
  const tr = useT()
  // Only show the open conversation if it is one of this company's.
  const open = chat && threads.some((t) => t.id === activeId) ? chat : null
  return (
    <div className="company-chats">
      <nav className="thread-list" aria-label={tr('companies.chats.aria')}>
        {threads.length === 0 && <p className="muted small pad">{tr('companies.chats.none')}</p>}
        {threads.map((t) => (
          <div key={t.id} className={`thread-item${t.id === activeId ? ' active' : ''}`} role="button" tabIndex={0} onClick={() => onOpen(t.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(t.id)}>
            <div className="thread-title">
              {approvals.some((a) => a.threadId === t.id) ? <span className="dot warn" title={tr('sidebar.waiting')} /> : running.includes(t.id) && <span className="dot live" title={tr('sidebar.working')} />}
              <span className="ellipsis">{t.title}</span>
            </div>
            <div className="thread-meta">
              <span>{name(t.agentId)}</span>
              <span>{relativeTime(t.updatedAt, tr)}</span>
            </div>
            <button
              className="icon-button thread-delete"
              title={tr('sidebar.delete')}
              onClick={(e) => {
                e.stopPropagation()
                if (confirm(tr('sidebar.deleteConfirm', { title: t.title }))) onDelete(t.id)
              }}
            >
              <Icon icon={X} size="sm" />
            </button>
          </div>
        ))}
      </nav>
      <div className="company-chat">{open ?? <p className="muted pad">{tr('companies.chats.pick')}</p>}</div>
    </div>
  )
}

interface SectionProps {
  company: Company
  snapshot: CompanySnapshot
  settings: PublicSettings
  name(actor: CompanyActor): string
}

function Avatar({ name, busy }: { name: string; busy?: boolean }): React.JSX.Element {
  const tr = useT()
  return (
    <span className={`mini-avatar${busy ? ' busy' : ''}`} title={name} aria-label={name}>
      {name === tr('companies.board') ? '★' : initials(name)}
    </span>
  )
}

function Board({ company, snapshot, settings, name, onOpenThread }: SectionProps & { onOpenThread(id: string): void }): React.JSX.Element {
  const tr = useT()
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [dropOn, setDropOn] = useState<TaskStatus | null>(null)
  const task = snapshot.tasks.find((t) => t.id === open)

  return (
    <div className="board-wrap">
      <div className="board-bar">
        <button className="primary small" onClick={() => setCreating(true)}>
          <Icon icon={Plus} size={14} /> {tr('companies.newTask')}
        </button>
        <span className="small muted">{tr('companies.boardHint')}</span>
      </div>
      <div className="board">
        {COLUMNS.map((column) => {
          const tasks = snapshot.tasks.filter((t) => t.status === column).sort((a, b) => b.updatedAt - a.updatedAt)
          return (
            <div
              key={column}
              className={`board-column${dropOn === column ? ' drop' : ''}`}
              onDragOver={(e) => (e.preventDefault(), setDropOn(column))}
              onDragLeave={() => setDropOn(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDropOn(null)
                const id = e.dataTransfer.getData('text/x-alma-task')
                if (id) void request({ method: 'company.task.move', companyId: company.id, taskId: id, status: column })
              }}
            >
              <h3>
                {tr(`companies.col.${column}`)} <span className="muted">{tasks.length}</span>
              </h3>
              {tasks.map((t) => (
                <button
                  key={t.id}
                  className={`task-card status-${t.status}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('text/x-alma-task', t.id)}
                  onClick={() => setOpen(t.id)}
                >
                  <span className="task-title">{t.title}</span>
                  <span className="task-meta small muted">
                    <Avatar name={name(t.assignee)} busy={snapshot.working.includes(t.assignee) && t.status === 'in_progress'} />
                    <span className="ellipsis">{name(t.assignee)}</span>
                    <span className="grow" />
                    {t.comments.length > 0 && <span title={tr('companies.comments')}>💬 {t.comments.length}</span>}
                    {t.due && <span title={tr('companies.due')}>⏱ {t.due}</span>}
                  </span>
                  {t.status === 'review' && t.createdBy === 'user' && <span className="badge warn small">{tr('companies.reviewMine')}</span>}
                </button>
              ))}
            </div>
          )
        })}
      </div>
      {creating && <NewTask company={company} settings={settings} onClose={() => setCreating(false)} />}
      {task && <TaskDrawer task={task} company={company} name={name} onClose={() => setOpen(null)} onOpenThread={onOpenThread} />}
    </div>
  )
}

function NewTask({ company, settings, onClose }: { company: Company; settings: PublicSettings; onClose(): void }): React.JSX.Element {
  const tr = useT()
  const head = company.members.find((m) => m.reportsTo === null) ?? company.members[0]
  const [form, setForm] = useState({ title: '', description: '', assignee: head?.id ?? '' })
  const [error, setError] = useState('')
  const create = (): void => {
    if (!form.title.trim() || !form.assignee) return
    request({ method: 'company.task.create', companyId: company.id, ...form })
      .then(onClose)
      .catch((e: Error) => setError(e.message))
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small-modal" role="dialog" aria-label={tr('companies.newTask')}>
        <header className="modal-header">
          <h2>{tr('companies.newTask')}</h2>
          <button className="icon-button" onClick={onClose} title={tr('common.close')}>
            <Icon icon={X} size="sm" />
          </button>
        </header>
        <div className="modal-pad">
          <label className="field">
            <span>{tr('companies.task.what')}</span>
            <input autoFocus value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={tr('companies.task.whatExample')} />
          </label>
          <label className="field">
            <span>{tr('companies.task.details')}</span>
            <textarea rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="field">
            <span>{tr('companies.task.owner')}</span>
            <select value={form.assignee} onChange={(e) => setForm({ ...form, assignee: e.target.value })}>
              {company.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {settings.agents.find((a) => a.id === m.id)?.name ?? m.id} — {m.title}
                </option>
              ))}
            </select>
          </label>
          <p className="small muted">{tr('companies.task.ownerHint')}</p>
          {error && <p className="text-danger small">{error}</p>}
          <div className="row end">
            <button className="ghost" onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button className="primary" disabled={!form.title.trim() || !form.assignee} onClick={create}>
              {tr('companies.task.assign')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskDrawer({ task, company, name, onClose, onOpenThread }: { task: CompanyTask; company: Company; name(a: CompanyActor): string; onClose(): void; onOpenThread(id: string): void }): React.JSX.Element {
  const tr = useT()
  const [comment, setComment] = useState('')
  const send = (): void => {
    if (!comment.trim()) return
    void request({ method: 'company.task.comment', companyId: company.id, taskId: task.id, text: comment.trim() }).then(() => setComment(''))
  }
  const review = (approve: boolean): void =>
    void request({ method: 'company.task.review', companyId: company.id, taskId: task.id, approve, comment: comment.trim() || undefined }).then(() => setComment(''))

  return (
    <aside className="task-drawer" aria-label={tr('toolcard.task')}>
      <div className="row space">
        <span className={`badge status-${task.status}`}>{tr(`companies.col.${task.status}`)}</span>
        <button className="icon-button" onClick={onClose} title={tr('common.close')}>
          <Icon icon={X} size="sm" />
        </button>
      </div>
      <h3>{task.title}</h3>
      <p className="small muted">
        {tr('companies.task.meta', { assignee: name(task.assignee), creator: name(task.createdBy), when: relativeTime(task.updatedAt, tr) })}
        {task.revisions ? ` · ${tr('companies.task.revisions', { count: task.revisions })}` : ''}
      </p>
      {task.description && (
        <div className="card">
          <Markdown text={task.description} />
        </div>
      )}
      {task.result && (
        <div className="card">
          <h4>{tr('companies.task.delivery')}</h4>
          <Markdown text={task.result} />
        </div>
      )}
      {task.threadId && (
        <button className="ghost small" onClick={() => onOpenThread(task.threadId!)}>
          <Icon icon={MessageSquare} size={14} /> {tr('companies.task.seeHow')}
        </button>
      )}
      <div className="task-comments">
        {task.comments.map((c, i) => (
          <div key={i} className="task-comment">
            <strong>{name(c.author)}</strong> <span className="muted small">{relativeTime(c.at, tr)}</span>
            <div>{c.text}</div>
          </div>
        ))}
      </div>
      <textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={tr('companies.task.commentExample')} />
      <div className="row wrap">
        {task.status === 'review' ? (
          <>
            <button className="primary small" onClick={() => review(true)}>
              {tr('companies.task.approve')}
            </button>
            <button className="ghost small" onClick={() => review(false)} disabled={!comment.trim()} title={tr('companies.task.requestChangesTitle')}>
              {tr('companies.task.requestChanges')}
            </button>
          </>
        ) : (
          <button className="primary small" onClick={send} disabled={!comment.trim()}>
            <Icon icon={Send} size={14} /> {tr('companies.task.comment')}
          </button>
        )}
        <span className="grow" />
        <button
          className="ghost small danger-text"
          onClick={() => confirm(tr('companies.task.deleteConfirm')) && void request({ method: 'company.task.delete', companyId: company.id, taskId: task.id }).then(onClose)}
        >
          <Icon icon={Trash2} size={14} /> {tr('common.delete')}
        </button>
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------

function Meetings({ company, snapshot, settings, name, onOpenMinutes }: SectionProps & { onOpenMinutes(path: string): void }): React.JSX.Element {
  const tr = useT()
  const language = useLanguage()
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const meetings = useMemo(() => [...snapshot.meetings].sort((a, b) => b.at - a.at), [snapshot.meetings])
  const meeting = meetings.find((m) => m.id === open) ?? meetings.find((m) => m.status === 'live')

  return (
    <div className="meetings">
      <div className="meeting-list">
        <button className="primary small" onClick={() => setCreating(true)}>
          <Icon icon={Plus} size={14} /> {tr('companies.meeting.new')}
        </button>
        {meetings.length === 0 && <p className="small muted">{tr('companies.meeting.none')}</p>}
        {meetings.map((m) => (
          <button key={m.id} className={`meeting-item${meeting?.id === m.id ? ' active' : ''}`} onClick={() => setOpen(m.id)}>
            <strong className="ellipsis">{m.topic}</strong>
            <span className="small muted">
              {formatDateTime(language, m.at, 'short')} · {tr(`companies.meeting.state.${m.status}`)}
            </span>
          </button>
        ))}
      </div>
      {meeting ? (
        <MeetingRoom meeting={meeting} company={company} name={name} working={snapshot.working} onOpenMinutes={onOpenMinutes} />
      ) : (
        <div className="vault-empty muted">
          <p>{tr('companies.meeting.explain')}</p>
        </div>
      )}
      {creating && <NewMeeting company={company} settings={settings} onClose={() => setCreating(false)} onCreated={(id) => setOpen(id)} />}
    </div>
  )
}

function MeetingRoom({ meeting, company, name, working, onOpenMinutes }: { meeting: Meeting; company: Company; name(a: CompanyActor): string; working: string[]; onOpenMinutes(path: string): void }): React.JSX.Element {
  const tr = useT()
  const language = useLanguage()
  const [text, setText] = useState('')
  const say = (): void => {
    if (!text.trim()) return
    void request({ method: 'company.meeting.say', companyId: company.id, meetingId: meeting.id, text: text.trim() }).then(() => setText(''))
  }
  const speaking = meeting.participants.find((id) => working.includes(id))
  return (
    <div className="meeting-room">
      <div className="row space">
        <div>
          <h3>{meeting.topic}</h3>
          <p className="small muted">
            {tr('companies.meeting.line', {
              date: formatDateTime(language, meeting.at, 'long'),
              chair: name(meeting.chair),
              state: tr(`companies.meeting.state.${meeting.status}`)
            })}
          </p>
        </div>
        <div className="row">
          {meeting.status === 'scheduled' && (
            <>
              <button className="primary small" onClick={() => void request({ method: 'company.meeting.start', companyId: company.id, meetingId: meeting.id })}>
                <Icon icon={Play} size={14} /> {tr('companies.meeting.startNow')}
              </button>
              <button className="ghost small" onClick={() => void request({ method: 'company.meeting.cancel', companyId: company.id, meetingId: meeting.id })}>
                {tr('common.cancel')}
              </button>
            </>
          )}
          {meeting.status === 'live' && (
            <button className="ghost small" onClick={() => void request({ method: 'company.meeting.end', companyId: company.id, meetingId: meeting.id })}>
              <Icon icon={Square} size={14} /> {tr('companies.meeting.end')}
            </button>
          )}
          {meeting.minutesPath && (
            <button className="primary small" onClick={() => onOpenMinutes(meeting.minutesPath!)}>
              {tr('companies.meeting.minutes')}
            </button>
          )}
        </div>
      </div>
      <div className="meeting-people">
        {meeting.participants.map((id) => (
          <span key={id} className={`person${working.includes(id) ? ' speaking' : ''}`} title={meeting.prep[id] ? tr('companies.meeting.prepared') : tr('companies.meeting.notPrepared')}>
            <Avatar name={name(id)} busy={working.includes(id)} /> {name(id)} {meeting.prep[id] ? '✓' : ''}
          </span>
        ))}
      </div>
      <ol className="agenda small">
        {meeting.agenda.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ol>
      <div className="transcript">
        {meeting.transcript.length === 0 && (
          <p className="muted small">
            {meeting.status === 'preparing' ? tr('companies.meeting.preparing') : meeting.status === 'scheduled' ? tr('companies.meeting.prepNote', { hours: meeting.prepHours }) : ''}
          </p>
        )}
        {meeting.transcript.map((turn, i) => (
          <div key={i} className={`turn${turn.speaker === 'user' ? ' mine' : ''}${turn.speaker === meeting.chair ? ' chair' : ''}`}>
            <Avatar name={name(turn.speaker)} />
            <div>
              <strong>{name(turn.speaker)}</strong>
              <Markdown text={turn.text} />
            </div>
          </div>
        ))}
        {meeting.status === 'live' && speaking && <p className="small muted typing">{tr('companies.meeting.speaking', { name: name(speaking) })}</p>}
      </div>
      {meeting.status === 'live' && (
        <div className="row">
          <input className="grow" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && say()} placeholder={tr('companies.meeting.sayExample')} />
          <button className="primary" onClick={say} disabled={!text.trim()}>
            {tr('companies.meeting.say')}
          </button>
        </div>
      )}
      {meeting.decisions && meeting.decisions.length > 0 && (
        <div className="card">
          <h4>{tr('companies.meeting.decisions')}</h4>
          <ul>
            {meeting.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function localInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function NewMeeting({ company, settings, onClose, onCreated }: { company: Company; settings: PublicSettings; onClose(): void; onCreated(id: string): void }): React.JSX.Element {
  const tr = useT()
  const head = company.members.find((m) => m.reportsTo === null) ?? company.members[0]
  const [form, setForm] = useState({
    topic: '',
    agenda: '',
    participants: company.members.map((m) => m.id),
    chair: head?.id ?? '',
    at: localInput(Date.now() + 3 * 3_600_000),
    prepHours: 2
  })
  const [error, setError] = useState('')
  const agentName = (id: string): string => settings.agents.find((a) => a.id === id)?.name ?? id
  const create = (): void => {
    const agenda = form.agenda.split('\n').map((l) => l.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter(Boolean)
    if (!form.topic.trim() || !agenda.length) return setError(tr('companies.meeting.needTopic'))
    request<Meeting>({
      method: 'company.meeting.create',
      companyId: company.id,
      topic: form.topic.trim(),
      agenda,
      participants: form.participants,
      chair: form.chair,
      at: new Date(form.at).getTime(),
      prepHours: form.prepHours
    })
      .then((m) => {
        onCreated(m.id)
        onClose()
      })
      .catch((e: Error) => setError(e.message))
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small-modal" role="dialog" aria-label={tr('companies.meeting.new')}>
        <header className="modal-header">
          <h2>{tr('companies.meeting.new')}</h2>
          <button className="icon-button" onClick={onClose} title={tr('common.close')}>
            <Icon icon={X} size="sm" />
          </button>
        </header>
        <div className="modal-pad">
          <label className="field">
            <span>{tr('companies.meeting.topic')}</span>
            <input autoFocus value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} placeholder={tr('companies.meeting.topicExample')} />
          </label>
          <label className="field">
            <span>{tr('companies.meeting.agenda')}</span>
            <textarea rows={4} value={form.agenda} onChange={(e) => setForm({ ...form, agenda: e.target.value })} placeholder={tr('companies.meeting.agendaExample')} />
          </label>
          <div className="row">
            <label className="field grow">
              <span>{tr('routines.when')}</span>
              <input type="datetime-local" value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />
            </label>
            <label className="field">
              <span>{tr('companies.meeting.prepHours')}</span>
              <input type="number" min={0} max={48} value={form.prepHours} onChange={(e) => setForm({ ...form, prepHours: Math.max(0, Number(e.target.value)) })} />
            </label>
          </div>
          <label className="field">
            <span>{tr('companies.meeting.chair')}</span>
            <select value={form.chair} onChange={(e) => setForm({ ...form, chair: e.target.value })}>
              {company.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {agentName(m.id)} — {m.title}
                </option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>{tr('companies.meeting.participants')}</span>
            <div className="row wrap">
              {company.members.map((m) => (
                <label key={m.id} className="check">
                  <input
                    type="checkbox"
                    checked={form.participants.includes(m.id) || m.id === form.chair}
                    disabled={m.id === form.chair}
                    onChange={(e) => setForm({ ...form, participants: e.target.checked ? [...form.participants, m.id] : form.participants.filter((id) => id !== m.id) })}
                  />
                  {agentName(m.id)}
                </label>
              ))}
            </div>
          </div>
          <p className="small muted">{tr('companies.meeting.wakeNote')}</p>
          {error && <p className="text-danger small">{error}</p>}
          <div className="row end">
            <button className="ghost" onClick={onClose}>
              {tr('common.cancel')}
            </button>
            <button className="primary" onClick={create}>
              {tr('companies.meeting.schedule')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Activity({ snapshot, name }: { snapshot: CompanySnapshot; name(a: CompanyActor): string }): React.JSX.Element {
  const tr = useT()
  const items = [...snapshot.activity].reverse()
  return (
    <div className="activity">
      {items.length === 0 && <p className="muted small">{tr('companies.activity.none')}</p>}
      {items.map((a, i) => (
        <div key={i} className="activity-item">
          <Avatar name={name(a.actor)} />
          <div>
            <strong>{name(a.actor)}</strong> {a.text}
            <div className="small muted">{relativeTime(a.at, tr)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
