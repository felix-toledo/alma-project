// One device: its controls (by kind), its name and room, its sensors, and for a camera its live picture.
import { Camera, Pause, Play, SkipBack, SkipForward, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { isSensitive, type HomeArea, type HomeThing } from '../../../shared/home'
import { request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'
import { control, KIND_ICON, KIND_LABEL, statusText, toggleThing } from './homeLib'

interface Props {
  thing: HomeThing
  areas: HomeArea[]
  /** Where Home Assistant answers, for the camera stream. */
  baseUrl: string | undefined
  onClose(): void
}

const SWATCHES: [string, [number, number, number]][] = [
  ['Rojo', [255, 40, 40]],
  ['Naranja', [255, 130, 20]],
  ['Amarillo', [255, 220, 0]],
  ['Verde', [40, 200, 90]],
  ['Celeste', [60, 190, 255]],
  ['Azul', [50, 90, 255]],
  ['Violeta', [160, 60, 255]],
  ['Rosa', [255, 90, 170]]
]

function Slider({ label, value, min = 0, max = 100, unit = '%', onCommit }: { label: string; value: number; min?: number; max?: number; unit?: string; onCommit(value: number): void }): React.JSX.Element {
  const [local, setLocal] = useState(value)
  useEffect(() => setLocal(value), [value])
  const commit = (): void => {
    if (local !== value) onCommit(local)
  }
  return (
    <label className="home-slider">
      <span>
        {label} <b>{Math.round(local)}{unit}</b>
      </span>
      <input type="range" min={min} max={max} value={local} onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
    </label>
  )
}

export function DevicePanel({ thing, areas, baseUrl, onClose }: Props): React.JSX.Element {
  const [name, setName] = useState(thing.name)
  const [still, setStill] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => {
    setName(thing.name)
    setStill(null)
    setPaused(false)
    setMessage('')
  }, [thing.id, thing.name])

  const run = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    setMessage('')
    try {
      await work()
    } catch (error) {
      setMessage((error as Error).message)
    } finally {
      setBusy('')
    }
  }
  const sensitive = isSensitive(thing.kind, thing.deviceClass)
  const brightness = typeof thing.attrs.brightness === 'number' ? Math.round((thing.attrs.brightness / 255) * 100) : 100
  const stream = thing.kind === 'camera' && baseUrl && typeof thing.attrs.entity_picture === 'string' ? `${baseUrl}${thing.attrs.entity_picture.replace('/camera_proxy/', '/camera_proxy_stream/')}` : null
  const rename = (): void => {
    if (name.trim() && name.trim() !== thing.name) void run('name', () => request({ method: 'home.thing.update', id: thing.id, name: name.trim() }))
  }

  return (
    <aside className="home-panel" aria-label={`Dispositivo ${thing.name}`}>
      <header>
        <span className="home-panel-icon">
          <Icon icon={KIND_ICON[thing.kind]} size="sm" />
        </span>
        <div className="grow">
          <input className="home-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} aria-label="Nombre" />
          <div className="muted small">
            {KIND_LABEL[thing.kind]} · {statusText(thing)}
          </div>
        </div>
        <button className="icon-button" onClick={onClose} title="Cerrar">
          <Icon icon={X} size="sm" />
        </button>
      </header>

      {stream && (
        <div className="home-camera">
          <img src={still ?? (paused ? undefined : stream)} alt={`Imagen de ${thing.name}`} />
          <div className="row">
            <button className="ghost small" disabled={busy === 'snap'} onClick={() =>
                void run('snap', async () => {
                  // The camera serves one video connection at a time: close the live picture before asking for the still.
                  setPaused(true)
                  try {
                    await new Promise((resolve) => setTimeout(resolve, 1200))
                    setStill(await request<string>({ method: 'home.camera.snapshot', entityId: thing.entityId }))
                  } finally {
                    setPaused(false)
                  }
                })
              }>
              <Icon icon={Camera} size={14} /> Foto
            </button>
            {still && (
              <button className="ghost small" onClick={() => setStill(null)}>
                Volver al vivo
              </button>
            )}
          </div>
        </div>
      )}

      {thing.available && !sensitive && (thing.kind === 'light' || thing.kind === 'switch' || thing.kind === 'fan') && (
        <div className="row">
          <button className={thing.on ? 'primary' : ''} onClick={() => void run('toggle', () => toggleThing(thing))}>
            {thing.on ? 'Apagar' : 'Encender'}
          </button>
        </div>
      )}

      {thing.available && thing.kind === 'light' && thing.on && (
        <>
          {'brightness' in thing.attrs && <Slider label="Brillo" value={brightness} min={1} onCommit={(v) => void run('b', () => control(thing.entityId, 'light/turn_on', { brightness_pct: v }))} />}
          {Array.isArray(thing.attrs.supported_color_modes) && (thing.attrs.supported_color_modes as string[]).includes('color_temp') && (
            <div className="row">
              {([['Cálida', 2700], ['Neutra', 4000], ['Fría', 6000]] as const).map(([label, kelvin]) => (
                <button key={label} className="ghost small" onClick={() => void run('t', () => control(thing.entityId, 'light/turn_on', { color_temp_kelvin: kelvin }))}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {Array.isArray(thing.attrs.supported_color_modes) && (thing.attrs.supported_color_modes as string[]).some((m) => ['rgb', 'rgbw', 'rgbww', 'hs', 'xy'].includes(m)) && (
            <div className="swatches" role="group" aria-label="Color">
              {SWATCHES.map(([label, rgb]) => (
                <button key={label} className="swatch" title={label} aria-label={label} style={{ background: `rgb(${rgb.join(',')})` }} onClick={() => void run('c', () => control(thing.entityId, 'light/turn_on', { rgb_color: rgb }))} />
              ))}
            </div>
          )}
        </>
      )}

      {thing.available && thing.kind === 'speaker' && (
        <>
          <div className="row">
            <button className="icon-button" title="Anterior" onClick={() => void run('p', () => control(thing.entityId, 'media_player/media_previous_track'))}>
              <Icon icon={SkipBack} size="sm" />
            </button>
            <button className="icon-button" title={thing.state === 'playing' ? 'Pausar' : 'Reproducir'} onClick={() => void run('p', () => control(thing.entityId, thing.state === 'playing' ? 'media_player/media_pause' : 'media_player/media_play'))}>
              <Icon icon={thing.state === 'playing' ? Pause : Play} size="sm" />
            </button>
            <button className="icon-button" title="Siguiente" onClick={() => void run('p', () => control(thing.entityId, 'media_player/media_next_track'))}>
              <Icon icon={SkipForward} size="sm" />
            </button>
          </div>
          {typeof thing.attrs.volume_level === 'number' && <Slider label="Volumen" value={Math.round(thing.attrs.volume_level * 100)} onCommit={(v) => void run('v', () => control(thing.entityId, 'media_player/volume_set', { volume_level: v / 100 }))} />}
        </>
      )}

      {thing.available && thing.kind === 'cover' && (
        <>
          <div className="row">
            <button onClick={() => void run('c', () => control(thing.entityId, 'cover/open_cover'))}>Abrir</button>
            <button onClick={() => void run('c', () => control(thing.entityId, 'cover/close_cover'))}>Cerrar</button>
            <button className="ghost" onClick={() => void run('c', () => control(thing.entityId, 'cover/stop_cover'))}>
              Parar
            </button>
          </div>
          {typeof thing.attrs.current_position === 'number' && <Slider label="Abierta" value={thing.attrs.current_position} onCommit={(v) => void run('c', () => control(thing.entityId, 'cover/set_cover_position', { position: v }))} />}
        </>
      )}

      {thing.available && thing.kind === 'fan' && typeof thing.attrs.percentage === 'number' && <Slider label="Velocidad" value={thing.attrs.percentage} onCommit={(v) => void run('f', () => control(thing.entityId, 'fan/set_percentage', { percentage: v }))} />}

      {thing.available && thing.kind === 'climate' && typeof thing.attrs.temperature === 'number' && (
        <Slider label="Temperatura" unit="°" value={thing.attrs.temperature} min={Number(thing.attrs.min_temp ?? 16)} max={Number(thing.attrs.max_temp ?? 30)} onCommit={(v) => void run('t', () => control(thing.entityId, 'climate/set_temperature', { temperature: v }))} />
      )}

      {thing.available && thing.kind === 'lock' && (
        <div className="row">
          <button
            onClick={() => confirm(`¿${thing.on ? 'Cerrar con llave' : 'Abrir'} «${thing.name}»?`) && void run('l', () => control(thing.entityId, thing.on ? 'lock/lock' : 'lock/unlock'))}
          >
            {thing.on ? 'Cerrar con llave' : 'Abrir'}
          </button>
        </div>
      )}

      {thing.available && thing.kind === 'alarm' && (
        <div className="row">
          {thing.entityId.startsWith('alarm_control_panel.') ? (
            <>
              <button onClick={() => confirm('¿Activar la alarma?') && void run('a', () => control(thing.entityId, 'alarm_control_panel/alarm_arm_away'))}>Activar</button>
              <button onClick={() => confirm('¿Desactivar la alarma?') && void run('a', () => control(thing.entityId, 'alarm_control_panel/alarm_disarm'))}>Desactivar</button>
            </>
          ) : (
            <button onClick={() => void run('a', () => control(thing.entityId, thing.on ? 'siren/turn_off' : 'siren/turn_on'))}>{thing.on ? 'Silenciar' : 'Sonar'}</button>
          )}
        </div>
      )}

      {thing.sensors.length > 0 && (
        <ul className="home-sensors">
          {thing.sensors.map((sensor) => (
            <li key={sensor.entityId}>
              <span className="muted">{sensor.name}</span>
              <b>
                {sensor.state}
                {sensor.unit ?? ''}
              </b>
            </li>
          ))}
        </ul>
      )}

      <label className="field">
        <span>Habitación</span>
        <select value={thing.areaId ?? ''} onChange={(e) => void run('area', () => request({ method: 'home.thing.update', id: thing.id, areaId: e.target.value || null }))}>
          <option value="">Sin habitación</option>
          {areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </select>
      </label>

      <div className="muted small">
        {[thing.manufacturer, thing.model, thing.integration].filter(Boolean).join(' · ')}
        <br />
        <span className="mono">{thing.entityId}</span>
      </div>
      {message && <p className="small text-danger">{message}</p>}
      <button
        className="ghost small danger-text"
        onClick={() => confirm(`¿Quitar «${thing.name}» de la casa?`) && void run('rm', async () => (setMessage(await request<string>({ method: 'home.thing.remove', id: thing.id })), onClose()))}
      >
        <Icon icon={Trash2} size={14} /> Quitar dispositivo
      </button>
    </aside>
  )
}
