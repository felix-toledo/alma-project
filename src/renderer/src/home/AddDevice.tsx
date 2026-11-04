// "Agregar dispositivo": pick a brand, then answer whatever Home Assistant asks, one step at a time. The forms are drawn
// from the step itself (text, passwords, lists, a QR to scan), so every brand Home Assistant knows works here.
import { ArrowLeft, ExternalLink, Loader2, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { POPULAR_INTEGRATIONS, type FlowField, type FlowStep, type HomeIntegration } from '../../../shared/home'
import { request } from '../lib/coordinator'
import { Markdown } from '../components/Markdown'
import { Icon } from '../umbra/Icon'

interface Props {
  onClose(): void
  /** A step an agent already started (a QR to scan): continue it here. */
  initialStep?: FlowStep | null
}

const defaultsOf = (step: FlowStep): Record<string, unknown> => Object.fromEntries(step.fields.map((f) => [f.name, f.default ?? (f.type === 'boolean' ? false : f.type === 'multi_select' ? [] : '')]))

function Field({ field, value, onChange, error }: { field: FlowField; value: unknown; onChange(value: unknown): void; error?: string }): React.JSX.Element {
  const label = field.label ?? field.name.replace(/_/g, ' ')
  let input: React.JSX.Element
  switch (field.type) {
    case 'boolean':
      input = (
        <label className="row">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> <span>{label}</span>
        </label>
      )
      return (
        <div className="field">
          {input}
          {field.hint && <span className="muted small">{field.hint}</span>}
          {error && <span className="small text-danger">{error}</span>}
        </div>
      )
    case 'select':
      input = (
        <select value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {!field.required && <option value="" />}
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
      break
    case 'multi_select':
      input = (
        <div className="column">
          {field.options?.map((o) => (
            <label key={o.value} className="row">
              <input
                type="checkbox"
                checked={((value as string[]) ?? []).includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...((value as string[]) ?? []), o.value] : ((value as string[]) ?? []).filter((v) => v !== o.value))}
              />{' '}
              {o.label}
            </label>
          ))}
        </div>
      )
      break
    case 'integer':
    case 'float':
      input = <input type="number" min={field.min} max={field.max} step={field.type === 'float' ? 'any' : 1} value={String(value ?? '')} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      break
    default:
      input = <input type={field.type === 'password' ? 'password' : 'text'} autoComplete="off" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
  }
  return (
    <label className="field">
      <span>
        {label}
        {field.required ? ' *' : ''}
      </span>
      {input}
      {field.hint && <span className="muted small">{field.hint}</span>}
      {error && <span className="small text-danger">{error}</span>}
    </label>
  )
}

export function AddDevice({ onClose, initialStep }: Props): React.JSX.Element {
  const [step, setStep] = useState<FlowStep | null>(initialStep ?? null)
  const [values, setValues] = useState<Record<string, unknown>>(initialStep ? defaultsOf(initialStep) : {})
  const [integrations, setIntegrations] = useState<HomeIntegration[] | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void request<HomeIntegration[]>({ method: 'home.integrations' }).then(setIntegrations).catch((e: Error) => setError(e.message))
  }, [])

  const open = step && (step.kind === 'form' || step.kind === 'menu' || step.kind === 'external' || step.kind === 'progress')
  const close = (): void => {
    if (open) void request({ method: 'home.flow.abort', flowId: step.flowId }).catch(() => undefined)
    onClose()
  }

  const show = (next: FlowStep): void => {
    setStep(next)
    setValues(defaultsOf(next))
  }

  const call = async (work: () => Promise<FlowStep>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      show(await work())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const matches = useMemo(() => {
    const wanted = query.trim().toLowerCase()
    if (!wanted || !integrations) return []
    return integrations.filter((i) => i.name.toLowerCase().includes(wanted) || i.domain.includes(wanted)).slice(0, 40)
  }, [query, integrations])
  const available = new Set(integrations?.map((i) => i.domain))

  const missing = step?.kind === 'form' ? step.fields.filter((f) => f.required && f.type !== 'boolean' && (values[f.name] === '' || values[f.name] === undefined)) : []

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal home-add" role="dialog" aria-label="Agregar dispositivo">
        <header className="modal-header">
          {step && step.kind !== 'done' && (
            <button className="icon-button" title="Elegir otra marca" onClick={() => (open && void request({ method: 'home.flow.abort', flowId: step.flowId }).catch(() => undefined), setStep(null))}>
              <Icon icon={ArrowLeft} size="sm" />
            </button>
          )}
          <h2>{step ? step.title : 'Agregar dispositivo'}</h2>
          <button className="icon-button" onClick={close} title="Cerrar">
            <Icon icon={X} size="sm" />
          </button>
        </header>
        <div className="modal-body home-add-body">
          {error && <p className="small text-danger">{error}</p>}

          {!step && (
            <>
              <p className="muted small">Elegí la marca. Alma le pregunta a Home Assistant qué necesita y te lo pide acá; las cuentas se usan solo para conectar tus dispositivos.</p>
              <label className="field home-search">
                <Icon icon={Search} size={16} />
                <input autoFocus placeholder="Buscar marca (Tuya, Sonoff, Tapo, Hue, Chromecast…)" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              {!integrations && !error && (
                <p className="muted small">
                  <Icon icon={Loader2} size={14} className="spin" /> Cargando marcas…
                </p>
              )}
              <ul className="home-brands">
                {(query ? matches.map((i) => ({ domain: i.domain, name: i.name, hint: '' })) : POPULAR_INTEGRATIONS.filter((p) => !integrations || available.has(p.domain) || p.domain === 'sonoff')).map((brand) => (
                  <li key={brand.domain}>
                    <button className="home-brand" disabled={busy} onClick={() => void call(() => request<FlowStep>({ method: 'home.flow.start', domain: brand.domain }))}>
                      <b>{brand.name}</b>
                      {brand.hint && <span className="muted small">{brand.hint}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              {query && integrations && matches.length === 0 && <p className="muted small">No hay una marca con ese nombre. Probá con otra palabra.</p>}
            </>
          )}

          {step?.kind === 'form' && (
            <form
              className="column"
              onSubmit={(e) => {
                e.preventDefault()
                if (!missing.length) void call(() => request<FlowStep>({ method: 'home.flow.step', flowId: step.flowId, data: values }))
              }}
            >
              {step.description && (
                <div className="home-desc">
                  <Markdown text={step.description} />
                </div>
              )}
              {step.qr && (
                <div className="home-qr">
                  <img src={step.qr} alt="Código QR para escanear con la app del fabricante" />
                  <p className="muted small">Abrí la app del fabricante en el celular y escaneá este código. Después tocá «Siguiente».</p>
                </div>
              )}
              {step.errors[''] && <p className="small text-danger">{step.errors['']}</p>}
              {step.fields.map((field) => (
                <Field key={field.name} field={field} value={values[field.name]} onChange={(v) => setValues((s) => ({ ...s, [field.name]: v }))} error={step.errors[field.name]} />
              ))}
              <div className="row">
                <button className="primary" type="submit" disabled={busy || missing.length > 0}>
                  {busy ? <Icon icon={Loader2} size={14} className="spin" /> : null} Siguiente
                </button>
                {missing.length > 0 && <span className="muted small">Falta: {missing.map((f) => f.label ?? f.name).join(', ')}</span>}
              </div>
            </form>
          )}

          {step?.kind === 'menu' && (
            <div className="column">
              {step.description && (
                <div className="home-desc">
                  <Markdown text={step.description} />
                </div>
              )}
              <ul className="home-brands">
                {step.menu?.map((option) => (
                  <li key={option.id}>
                    <button className="home-brand" disabled={busy} onClick={() => void call(() => request<FlowStep>({ method: 'home.flow.step', flowId: step.flowId, menu: option.id }))}>
                      <b>{option.label}</b>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {step?.kind === 'external' && (
            <div className="column">
              <div className="home-desc">
                <Markdown text={step.description} />
              </div>
              <div className="row">
                <a className="button primary" href={step.url} target="_blank" rel="noreferrer">
                  <Icon icon={ExternalLink} size={14} /> Abrir la página
                </a>
                <button disabled={busy} onClick={() => void call(() => request<FlowStep>({ method: 'home.flow.step', flowId: step.flowId }))}>
                  Ya lo hice
                </button>
              </div>
            </div>
          )}

          {step?.kind === 'progress' && (
            <div className="column">
              <p className="home-desc">
                <Icon icon={Loader2} size={14} className="spin" /> {step.description}
              </p>
              <button disabled={busy} onClick={() => void call(() => request<FlowStep>({ method: 'home.flow.step', flowId: step.flowId }))}>
                Revisar de nuevo
              </button>
            </div>
          )}

          {step?.kind === 'done' && (
            <div className="column">
              <p className="home-desc">✔ Listo, se agregó <b>{step.title}</b>. Los dispositivos aparecen en unos segundos; después podés ponerles nombre y ubicarlos en el plano.</p>
              <div className="row">
                <button className="primary" onClick={onClose}>
                  Cerrar
                </button>
                <button onClick={() => setStep(null)}>Agregar otro</button>
              </div>
            </div>
          )}

          {step?.kind === 'abort' && (
            <div className="column">
              <p className="home-desc text-danger">{step.reason}</p>
              <button onClick={() => setStep(null)}>Volver</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
