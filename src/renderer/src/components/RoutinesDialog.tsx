import { useEffect, useState } from 'react'
import { formatDateTime } from '../../../shared/i18n/format'
import type { Language } from '../../../shared/i18n/language'
import { describeSchedule, nextRun } from '../../../shared/schedule'
import type { PublicSettings, Routine, RoutineState } from '../../../shared/types'
import { useLanguage, useT, type T } from '../i18n/useT'
import { request } from '../lib/coordinator'
import { agentName, folderName, relativeTime } from '../lib/format'
import { Folder, Play, X } from 'lucide-react'
import { Icon } from '../umbra/Icon'

interface Props {
  settings: PublicSettings
  state: Record<string, RoutineState>
  onChange(patch: Partial<PublicSettings>): Promise<void>
  onOpenThread(threadId: string): void
  onClose(): void
}

const DAYS = [1, 2, 3, 4, 5, 6, 0] as const

function blankRoutine(settings: PublicSettings): Routine {
  return {
    id: `rutina-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    agentId: settings.defaultAgentId,
    workspace: settings.defaultWorkspace,
    prompt: '',
    schedule: { kind: 'daily', time: '09:00', days: [] },
    enabled: true,
    createdAt: Date.now()
  }
}

function instagramTemplate(settings: PublicSettings, t: T): Routine {
  return {
    ...blankRoutine(settings),
    name: t('routines.template.name'),
    agentId: settings.agents.some((a) => a.id === 'community-manager') ? 'community-manager' : settings.defaultAgentId,
    prompt: t('routines.template.prompt'),
    schedule: { kind: 'daily', time: '10:00', days: [1, 2, 3, 4, 5] }
  }
}

function blankReminder(settings: PublicSettings): Routine {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  return { ...blankRoutine(settings), action: 'reminder', schedule: { kind: 'once', at: tomorrow.getTime() } }
}

/** epoch ms ⇄ the value of an <input type="datetime-local"> (local time, no zone). */
function toLocalInput(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDate(date: Date | undefined, language: Language): string {
  if (!date) return '—'
  return formatDateTime(language, date, 'weekday')
}

export function RoutinesDialog({ settings, state, onChange, onOpenThread, onClose }: Props): React.JSX.Element {
  const t = useT()
  const language = useLanguage()
  const [editing, setEditing] = useState<Routine | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 30_000)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const save = (routines: Routine[]): Promise<void> => onChange({ routines })
  const upsert = async (routine: Routine): Promise<void> => {
    const exists = settings.routines.some((r) => r.id === routine.id)
    await save(exists ? settings.routines.map((r) => (r.id === routine.id ? routine : r)) : [...settings.routines, routine])
    setEditing(null)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={t('sidebar.routines')}>
        <header className="modal-header">
          <h2>{t('routines.heading')}</h2>
          <button className="icon-button" onClick={onClose} title={t('common.close')}>
            <Icon icon={X} size="sm" />
          </button>
        </header>
        <section className="tab-content single">
          {editing ? (
            <RoutineEditor routine={editing} settings={settings} onSave={upsert} onCancel={() => setEditing(null)} />
          ) : (
            <>
              <p className="muted small">
                {t('routines.intro')}
              </p>
              <div className="row">
                <button className="primary" onClick={() => setEditing(blankReminder(settings))}>
                  {t('routines.addReminder')}
                </button>
                <button className="ghost" onClick={() => setEditing(blankRoutine(settings))}>
                  {t('routines.addRoutine')}
                </button>
                <button className="ghost" onClick={() => setEditing(instagramTemplate(settings, t))}>
                  {t('routines.addTemplate')}
                </button>
              </div>
              {settings.routines.length === 0 && <p className="muted">{t('routines.none')}</p>}
              {settings.routines.map((routine) => {
                const entry = state[routine.id]
                const next = nextRun(routine, entry?.lastRunAt, new Date())
                return (
                  <div key={routine.id} className="card">
                    <div className="row space">
                      <div>
                        <strong>{routine.name}</strong>{' '}
                        <span className="badge">{routine.action === 'reminder' ? t('routines.badge.reminder') : t('routines.badge.routine')}</span>{' '}
                        {entry?.running ? <span className="badge ok">{t('routines.running')}</span> : !routine.enabled && <span className="badge">{t('routines.paused')}</span>}
                        <div className="muted small">
                          {describeSchedule(routine, language)}
                          {routine.action !== 'reminder' && (
                            <>
                              {' '}· {agentName(settings.agents, routine.agentId)} · <Icon icon={Folder} size="sm" />{' '}
                              {routine.workspace ? folderName(routine.workspace) : t('routines.defaultFolder')}
                            </>
                          )}
                        </div>
                        {routine.action === 'reminder' && <div className="small">{routine.prompt}</div>}
                        <div className="muted small">
                          {t('routines.nextLast', {
                            next: routine.enabled ? formatDate(next, language) : '—',
                            last: entry?.lastRunAt ? relativeTime(entry.lastRunAt, t) : t('routines.never')
                          })}
                        </div>
                      </div>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={routine.enabled}
                          onChange={(e) => void upsert({ ...routine, enabled: e.target.checked })}
                        />
                        {t('routines.active')}
                      </label>
                    </div>
                    <div className="row">
                      <button
                        className="ghost small"
                        disabled={entry?.running}
                        onClick={() =>
                          void request<string | null>({ method: 'routines.runNow', routineId: routine.id }).then((threadId) => {
                            if (!threadId) return
                            onOpenThread(threadId)
                            onClose()
                          })
                        }
                      >
                        <Icon icon={Play} size="sm" /> {routine.action === 'reminder' ? t('routines.testReminder') : t('routines.runNow')}
                      </button>
                      {entry?.lastThreadId && (
                        <button
                          className="ghost small"
                          onClick={() => {
                            onOpenThread(entry.lastThreadId!)
                            onClose()
                          }}
                        >
                          {t('routines.lastRun')}
                        </button>
                      )}
                      <span className="grow" />
                      <button className="ghost small" onClick={() => setEditing(routine)}>
                        {t('routines.edit')}
                      </button>
                      <button
                        className="danger small"
                        onClick={() => confirm(t('routines.deleteConfirm', { name: routine.name })) && void save(settings.routines.filter((r) => r.id !== routine.id))}
                      >
                        {t('common.delete')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function RoutineEditor({
  routine,
  settings,
  onSave,
  onCancel
}: {
  routine: Routine
  settings: PublicSettings
  onSave(routine: Routine): Promise<void>
  onCancel(): void
}): React.JSX.Element {
  const t = useT()
  const [draft, setDraft] = useState(routine)
  const schedule = draft.schedule
  const [unit, setUnit] = useState<'h' | 'min'>(schedule.kind === 'interval' && schedule.minutes % 60 !== 0 ? 'min' : 'h')
  const intervalHours = unit === 'h'
  const isReminder = draft.action === 'reminder'
  const scheduleValid =
    schedule.kind === 'daily' ? /^\d{2}:\d{2}$/.test(schedule.time) : schedule.kind === 'interval' ? schedule.minutes >= 5 : Number.isFinite(schedule.at)
  // A reminder's name defaults to its message.
  const valid = (isReminder || draft.name.trim()) && draft.prompt.trim() && scheduleValid

  return (
    <div className="split-detail">
      <div className="row">
        <label className="check">
          <input type="radio" checked={isReminder} onChange={() => setDraft({ ...draft, action: 'reminder' })} />
          {t('routines.kind.reminder')}
        </label>
        <label className="check">
          <input type="radio" checked={!isReminder} onChange={() => setDraft({ ...draft, action: 'task' })} />
          {t('routines.kind.task')}
        </label>
      </div>
      {!isReminder && (
      <label className="field">
        <span>{t('common.name')}</span>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t('routines.template.name')} />
      </label>
      )}
      {!isReminder && (
      <div className="row">
        <label className="field">
          <span>{t('chat.agent')}</span>
          <select value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}>
            {settings.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>{t('routines.workspace')}</span>
          <div className="row">
            <input readOnly value={draft.workspace || t('routines.workspaceDefault')} className="grow" />
            <button
              className="ghost"
              onClick={async () => {
                const folder = await window.desktop.pickFolder()
                if (folder) setDraft({ ...draft, workspace: folder })
              }}
            >
              {t('general.pick')}
            </button>
          </div>
        </label>
      </div>
      )}
      <label className="field">
        <span>{isReminder ? t('routines.promptReminder') : t('routines.promptTask')}</span>
        <textarea
          rows={isReminder ? 2 : 5}
          value={draft.prompt}
          placeholder={isReminder ? t('routines.reminderExample') : ''}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
        />
      </label>
      <fieldset className="field">
        <legend>{t('routines.when')}</legend>
        <div className="row">
          <label className="check">
            <input
              type="radio"
              checked={schedule.kind === 'once'}
              onChange={() => setDraft({ ...draft, schedule: { kind: 'once', at: Date.now() + 60 * 60_000 } })}
            />
            {t('routines.once')}
          </label>
          <label className="check">
            <input
              type="radio"
              checked={schedule.kind === 'daily'}
              onChange={() => setDraft({ ...draft, schedule: { kind: 'daily', time: '09:00', days: [] } })}
            />
            {t('routines.daily')}
          </label>
          <label className="check">
            <input
              type="radio"
              checked={schedule.kind === 'interval'}
              onChange={() => setDraft({ ...draft, schedule: { kind: 'interval', minutes: 240 } })}
            />
            {t('routines.interval')}
          </label>
        </div>
        {schedule.kind === 'once' ? (
          <div className="row">
            <input
              type="datetime-local"
              value={toLocalInput(schedule.at)}
              onChange={(e) => setDraft({ ...draft, schedule: { kind: 'once', at: new Date(e.target.value).getTime() } })}
            />
            {schedule.at < Date.now() && <span className="text-warn small">{t('routines.past')}</span>}
          </div>
        ) : schedule.kind === 'daily' ? (
          <div className="row">
            <input type="time" value={schedule.time} onChange={(e) => setDraft({ ...draft, schedule: { ...schedule, time: e.target.value } })} />
            <div className="day-picker">
              {DAYS.map((day) => {
                const active = schedule.days.includes(day)
                return (
                  <button
                    key={day}
                    className={active ? 'active' : ''}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        schedule: { ...schedule, days: active ? schedule.days.filter((d) => d !== day) : [...schedule.days, day] }
                      })
                    }
                  >
                    {t(`routines.day.${day}`)}
                  </button>
                )
              })}
            </div>
            <span className="muted small">{schedule.days.length === 0 ? t('routines.everyDay') : ''}</span>
          </div>
        ) : (
          <div className="row">
            <span>{t('routines.every')}</span>
            <input
              type="number"
              min={1}
              style={{ width: 90 }}
              value={intervalHours ? schedule.minutes / 60 : schedule.minutes}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  schedule: { kind: 'interval', minutes: Math.max(1, Number(e.target.value) || 1) * (intervalHours ? 60 : 1) }
                })
              }
            />
            <select
              value={unit}
              onChange={(e) => {
                const next = e.target.value as 'h' | 'min'
                setUnit(next)
                if (next === 'h') setDraft({ ...draft, schedule: { kind: 'interval', minutes: Math.max(1, Math.round(schedule.minutes / 60)) * 60 } })
              }}
            >
              <option value="h">{t('routines.hours')}</option>
              <option value="min">{t('routines.minutes')}</option>
            </select>
          </div>
        )}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        {t('routines.active')}
      </label>
      <div className="row">
        <button
          className="primary"
          disabled={!valid}
          onClick={() => void onSave({ ...draft, name: isReminder ? draft.prompt.trim().slice(0, 60) : draft.name.trim() })}
        >
          {isReminder ? t('routines.saveReminder') : t('routines.saveRoutine')}
        </button>
        <button className="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}
