// Configuración → Casa: turn the module on, install or connect the engine, choose who answers the rules and which model
// looks at pictures, see the connected accounts. Everything is per computer: each person sets up what they have.
import { Loader2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { HomeEngineStatus, HomeEntry } from '../../../shared/home'
import type { PublicSettings } from '../../../shared/types'
import { onEvent, request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'
import './home.css'

interface Props {
  settings: PublicSettings
  onChange(patch: Partial<PublicSettings>): Promise<void>
  onSettingsReplaced(settings: PublicSettings): void
}

const STATE_LABEL: Record<HomeEngineStatus['state'], string> = {
  off: 'Apagado',
  missing: 'Sin instalar',
  installing: 'Instalando',
  starting: 'Arrancando',
  ready: 'Funcionando',
  error: 'Con error',
  unsupported: 'No disponible'
}

export function HomeSettings({ settings, onChange }: Props): React.JSX.Element {
  const config = settings.home
  const patch = (next: Partial<typeof config>): Promise<void> => onChange({ home: { ...config, ...next } })
  const [engine, setEngine] = useState<HomeEngineStatus | null>(null)
  const [entries, setEntries] = useState<HomeEntry[]>([])
  const [url, setUrl] = useState(config.externalUrl)
  const [token, setToken] = useState('')
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [login, setLogin] = useState<{ url: string; username: string; password: string } | null>(null)

  const reload = useCallback(() => {
    void request<HomeEngineStatus>({ method: 'home.status' }).then(setEngine)
  }, [])
  useEffect(() => {
    reload()
    return onEvent((event) => {
      if (event.type === 'home.engine') setEngine(event.status)
    })
  }, [reload])
  useEffect(() => {
    if (engine?.state !== 'ready') return setEntries([])
    void request<HomeEntry[]>({ method: 'home.entries' }).then(setEntries).catch(() => setEntries([]))
  }, [engine?.state])

  const state = engine?.state ?? 'off'
  const busy = state === 'installing' || state === 'starting'

  return (
    <>
      <div className="card">
        <h3>Domótica</h3>
        <p className="muted small">
          El mapa de tu casa y los dispositivos (luces, enchufes, cámaras, parlantes…): los manejás desde la sección Casa o pidiéndoselo a Alma por chat, voz o Telegram. Funciona con Tuya, eWeLink, Tapo y las miles de marcas que soporta Home Assistant, el motor que Alma usa por abajo.
        </p>
        <label className="row">
          <input type="checkbox" checked={config.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} /> Activar la domótica
        </label>
        {config.enabled && (
          <fieldset className="field">
            <legend>Motor</legend>
            <label className="row">
              <input type="radio" name="home-mode" checked={config.mode === 'managed'} onChange={() => void patch({ mode: 'managed' })} /> Que Alma lo instale y lo maneje (recomendado)
            </label>
            <label className="row">
              <input type="radio" name="home-mode" checked={config.mode === 'external'} onChange={() => void patch({ mode: 'external' })} /> Ya tengo un Home Assistant
            </label>
          </fieldset>
        )}
      </div>

      {config.enabled && (
        <div className="card">
          <h3>
            Estado del motor <span className={`badge ${state === 'ready' ? 'ok' : state === 'error' || state === 'unsupported' ? 'danger' : 'warn'}`}>{STATE_LABEL[state]}</span>
          </h3>
          {engine?.version && <p className="muted small">Home Assistant {engine.version} · {engine.url}</p>}
          {busy && (
            <>
              <p>
                <Icon icon={Loader2} size={14} className="spin" /> {engine?.step}
              </p>
              {engine?.progress !== undefined && <progress value={engine.progress} max={1} style={{ width: '100%' }} />}
            </>
          )}
          {engine?.error && <p className="small text-danger">{engine.error}</p>}

          {config.mode === 'managed' ? (
            <>
              <p className="muted small">
                Corre dentro de un Linux oculto (WSL2) llamado «alma-home». La primera vez baja unos 1,2 GB y ocupa unos 3 GB. Se apaga cuando cerrás Alma.
              </p>
              <div className="row">
                {state === 'missing' && (
                  <button className="primary" onClick={() => void request({ method: 'home.install' })}>
                    Instalar el motor
                  </button>
                )}
                {state === 'error' && (
                  <button className="primary" onClick={() => void request({ method: 'home.start' })}>
                    Reintentar
                  </button>
                )}
                {state === 'ready' && (
                  <button onClick={() => void request({ method: 'home.stop' })}>Detener</button>
                )}
                {state === 'off' && (
                  <button className="primary" onClick={() => void request({ method: 'home.start' })}>
                    Iniciar
                  </button>
                )}
                {(state === 'ready' || state === 'error') && (
                  <button
                    className="ghost danger-text"
                    onClick={() => confirm('¿Desinstalar el motor? Se borran los dispositivos conectados y las cuentas de las marcas (el plano y las reglas de Alma se conservan).') && void request({ method: 'home.uninstall' })}
                  >
                    Desinstalar
                  </button>
                )}
                {state === 'ready' && (
                  <button
                    className="ghost"
                    onClick={() => void request<{ url: string; username: string; password: string } | null>({ method: 'home.advanced' }).then(setLogin)}
                    title="Para emparejar algo raro o mirar los registros"
                  >
                    Abrir Home Assistant (avanzado)
                  </button>
                )}
              </div>
              {login && (
                <div className="card">
                  <p className="small">
                    Home Assistant tiene su propia pantalla. Entrá con este usuario (la cuenta la creó Alma; guardala solo si la necesitás):
                  </p>
                  <p className="mono">
                    usuario: {login.username}
                    <br />
                    contraseña: {login.password}
                  </p>
                  <div className="row">
                    <a className="button primary" href={login.url} target="_blank" rel="noreferrer">
                      Abrir {login.url}
                    </a>
                    <button className="ghost" onClick={() => setLogin(null)}>
                      Ocultar
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              <label className="field">
                <span>Dirección de tu Home Assistant</span>
                <input placeholder="http://192.168.1.20:8123" value={url} onChange={(e) => setUrl(e.target.value)} />
              </label>
              <label className="field">
                <span>Token de acceso de larga duración</span>
                <input type="password" placeholder="Perfil de usuario → Seguridad → Tokens de acceso de larga duración" value={token} onChange={(e) => setToken(e.target.value)} />
              </label>
              <div className="row">
                <button
                  className="primary"
                  disabled={!url.trim() || !token.trim()}
                  onClick={async () => {
                    setNote(null)
                    try {
                      await patch({ externalUrl: url.trim().replace(/\/+$/, '') })
                      await request({ method: 'home.connectExternal', url: url.trim(), token: token.trim() })
                      setToken('')
                      setNote({ ok: true, text: 'Conectado.' })
                    } catch (error) {
                      setNote({ ok: false, text: (error as Error).message })
                    }
                  }}
                >
                  Conectar
                </button>
                {note && <span className={`small ${note.ok ? '' : 'text-danger'}`}>{note.text}</span>}
              </div>
            </>
          )}
        </div>
      )}

      {config.enabled && (
        <div className="card">
          <h3>Cómo piensa Alma en la casa</h3>
          <label className="field">
            <span>Agente que responde las reglas con criterio</span>
            <select value={config.agentId} onChange={(e) => void patch({ agentId: e.target.value })}>
              <option value="">El agente por defecto</option>
              {settings.agents
                .filter((a) => !a.companyId)
                .map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="field">
            <span>Modelo que mira imágenes (planos y cámaras)</span>
            <div className="row">
              <select value={config.visionProvider} onChange={(e) => void patch({ visionProvider: e.target.value, ...(e.target.value ? {} : { visionModel: '' }) })}>
                <option value="">El del agente de arriba</option>
                <option value="anthropic">Claude</option>
                <option value="xai">Grok</option>
                <option value="deepseek">DeepSeek</option>
                <option value="vercel">Vercel AI Gateway</option>
                <option value="meta">Meta (Muse)</option>
              </select>
              {config.visionProvider && <input className="grow" placeholder="Modelo (con visión)" defaultValue={config.visionModel} onBlur={(e) => void patch({ visionModel: e.target.value.trim() })} />}
            </div>
            <span className="muted small">Cada foto de cámara que Alma mira cuesta unos pocos miles de tokens de imagen. Elegí un modelo barato que entienda imágenes si vas a usar vigilancia.</span>
          </div>
        </div>
      )}

      {config.enabled && entries.length > 0 && (
        <div className="card">
          <h3>Cuentas y marcas conectadas</h3>
          {entries.map((entry) => (
            <div key={entry.entryId} className="row space">
              <span>
                <b>{entry.title}</b> <span className="muted small">{entry.domain} · {entry.state === 'loaded' ? 'activa' : entry.state}</span>
              </span>
              <button
                className="ghost small danger-text"
                onClick={() => confirm(`¿Quitar «${entry.title}»? Se van todos sus dispositivos.`) && void request({ method: 'home.entry.remove', entryId: entry.entryId }).then(() => setEntries((list) => list.filter((e) => e.entryId !== entry.entryId)))}
              >
                Quitar
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
