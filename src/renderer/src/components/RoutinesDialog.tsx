import { useEffect, useState } from 'react'
import { describeSchedule, nextRun } from '../../../shared/schedule'
import type { PublicSettings, Routine, RoutineState } from '../../../shared/types'
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

const DAYS = [
  { value: 1, label: 'L' },
  { value: 2, label: 'M' },
  { value: 3, label: 'X' },
  { value: 4, label: 'J' },
  { value: 5, label: 'V' },
  { value: 6, label: 'S' },
  { value: 0, label: 'D' }
]

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

function instagramTemplate(settings: PublicSettings): Routine {
  return {
    ...blankRoutine(settings),
    name: 'Post diario de Instagram',
    agentId: settings.agents.some((a) => a.id === 'community-manager') ? 'community-manager' : settings.defaultAgentId,
    prompt:
      'Creá el post de hoy para Instagram siguiendo marca.md: elegí un tema que no se haya publicado (mirá publicaciones.md), generá la imagen, escribí el texto y publicalo. Después registralo en publicaciones.md.',
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

function formatDate(date: Date | undefined): string {
  if (!date) return '—'
  return date.toLocaleString('es', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function RoutinesDialog({ settings, state, onChange, onOpenThread, onClose }: Props): React.JSX.Element {
  const [editing, setEditing] = useState<Routine | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 30_000)
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
      <div className="modal" role="dialog" aria-label="Rutinas">
        <header className="modal-header">
          <h2>Rutinas y recordatorios</h2>
          <button className="icon-button" onClick={onClose} title="Cerrar">
            <Icon icon={X} size="sm" />
          </button>
        </header>
        <section className="tab-content single">
          {editing ? (
            <RoutineEditor routine={editing} settings={settings} onSave={upsert} onCancel={() => setEditing(null)} />
          ) : (
            <>
              <p className="muted small">
                Un recordatorio solo te avisa. En una rutina, un agente hace la tarea solo, a la hora programada, en una conversación
                nueva. También los podés pedir en el chat («haceme acordar…»). La app tiene que estar abierta o en la bandeja del sistema.
              </p>
              <div className="row">
                <button className="primary" onClick={() => setEditing(blankReminder(settings))}>
                  + Recordatorio
                </button>
                <button className="ghost" onClick={() => setEditing(blankRoutine(settings))}>
                  + Rutina con agente
                </button>
                <button className="ghost" onClick={() => setEditing(instagramTemplate(settings))}>
                  Plantilla: post diario de Instagram
                </button>
              </div>
              {settings.routines.length === 0 && <p className="muted">Todavía no hay rutinas.</p>}
              {settings.routines.map((routine) => {
                const entry = state[routine.id]
                const next = nextRun(routine, entry?.lastRunAt, new Date())
                return (
                  <div key={routine.id} className="card">
                    <div className="row space">
                      <div>
                        <strong>{routine.name}</strong>{' '}
                        <span className="badge">{routine.action === 'reminder' ? 'recordatorio' : 'rutina'}</span>{' '}
                        {entry?.running ? <span className="badge ok">ejecutándose</span> : !routine.enabled && <span className="badge">pausada</span>}
                        <div className="muted small">
                          {describeSchedule(routine)}
                          {routine.action !== 'reminder' && (
                            <>
                              {' '}· {agentName(settings.agents, routine.agentId)} · <Icon icon={Folder} size="sm" />{' '}
                              {routine.workspace ? folderName(routine.workspace) : 'carpeta por defecto'}
                            </>
                          )}
                        </div>
                        {routine.action === 'reminder' && <div className="small">{routine.prompt}</div>}
                        <div className="muted small">
                          Próxima: {routine.enabled ? formatDate(next) : '—'} · Última: {entry?.lastRunAt ? relativeTime(entry.lastRunAt) : 'nunca'}
                        </div>
                      </div>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={routine.enabled}
                          onChange={(e) => void upsert({ ...routine, enabled: e.target.checked })}
                        />
                        Activa
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
                        <Icon icon={Play} size="sm" /> {routine.action === 'reminder' ? 'Probar aviso' : 'Ejecutar ahora'}
                      </button>
                      {entry?.lastThreadId && (
                        <button
                          className="ghost small"
                          onClick={() => {
                            onOpenThread(entry.lastThreadId!)
                            onClose()
                          }}
                        >
                          Ver última ejecución
                        </button>
                      )}
                      <span className="grow" />
                      <button className="ghost small" onClick={() => setEditing(routine)}>
                        Editar
                      </button>
                      <button
                        className="danger small"
                        onClick={() => confirm(`¿Borrar la rutina «${routine.name}»?`) && void save(settings.routines.filter((r) => r.id !== routine.id))}
                      >
                        Borrar
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
          Recordatorio (solo te avisa)
        </label>
        <label className="check">
          <input type="radio" checked={!isReminder} onChange={() => setDraft({ ...draft, action: 'task' })} />
          Rutina (un agente hace una tarea)
        </label>
      </div>
      {!isReminder && (
      <label className="field">
        <span>Nombre</span>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Post diario de Instagram" />
      </label>
      )}
      {!isReminder && (
      <div className="row">
        <label className="field">
          <span>Agente</span>
          <select value={draft.agentId} onChange={(e) => setDraft({ ...draft, agentId: e.target.value })}>
            {settings.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>Carpeta de trabajo</span>
          <div className="row">
            <input readOnly value={draft.workspace || '(la carpeta por defecto)'} className="grow" />
            <button
              className="ghost"
              onClick={async () => {
                const folder = await window.desktop.pickFolder()
                if (folder) setDraft({ ...draft, workspace: folder })
              }}
            >
              Elegir…
            </button>
          </div>
        </label>
      </div>
      )}
      <label className="field">
        <span>{isReminder ? 'Qué te recuerdo' : 'Qué tiene que hacer (se le envía al agente en cada ejecución)'}</span>
        <textarea
          rows={isReminder ? 2 : 5}
          value={draft.prompt}
          placeholder={isReminder ? 'Llamar al dentista' : ''}
          onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
        />
      </label>
      <fieldset className="field">
        <legend>Cuándo</legend>
        <div className="row">
          <label className="check">
            <input
              type="radio"
              checked={schedule.kind === 'once'}
              onChange={() => setDraft({ ...draft, schedule: { kind: 'once', at: Date.now() + 60 * 60_000 } })}
            />
            Una vez
          </label>
          <label className="check">
            <input
              type="radio"
              checked={schedule.kind === 'daily'}
              onChange={() => setDraft({ ...draft, schedule: { kind: 'daily', time: '09:00', days: [] } })}
            />
            A una hora fija
          </label>
          <label className="check">
            <input
              type="radio"
              checked={schedule.kind === 'interval'}
              onChange={() => setDraft({ ...draft, schedule: { kind: 'interval', minutes: 240 } })}
            />
            Cada cierto tiempo
          </label>
        </div>
        {schedule.kind === 'once' ? (
          <div className="row">
            <input
              type="datetime-local"
              value={toLocalInput(schedule.at)}
              onChange={(e) => setDraft({ ...draft, schedule: { kind: 'once', at: new Date(e.target.value).getTime() } })}
            />
            {schedule.at < Date.now() && <span className="text-warn small">Esa fecha ya pasó: va a sonar apenas guardes.</span>}
          </div>
        ) : schedule.kind === 'daily' ? (
          <div className="row">
            <input type="time" value={schedule.time} onChange={(e) => setDraft({ ...draft, schedule: { ...schedule, time: e.target.value } })} />
            <div className="day-picker">
              {DAYS.map((day) => {
                const active = schedule.days.includes(day.value)
                return (
                  <button
                    key={day.value}
                    className={active ? 'active' : ''}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        schedule: { ...schedule, days: active ? schedule.days.filter((d) => d !== day.value) : [...schedule.days, day.value] }
                      })
                    }
                  >
                    {day.label}
                  </button>
                )
              })}
            </div>
            <span className="muted small">{schedule.days.length === 0 ? 'todos los días' : ''}</span>
          </div>
        ) : (
          <div className="row">
            <span>Cada</span>
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
              <option value="h">horas</option>
              <option value="min">minutos</option>
            </select>
          </div>
        )}
      </fieldset>
      <label className="check">
        <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
        Activa
      </label>
      <div className="row">
        <button
          className="primary"
          disabled={!valid}
          onClick={() => void onSave({ ...draft, name: isReminder ? draft.prompt.trim().slice(0, 60) : draft.name.trim() })}
        >
          {isReminder ? 'Guardar recordatorio' : 'Guardar rutina'}
        </button>
        <button className="ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </div>
  )
}
