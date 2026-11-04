// Modes (scenes) and rules: the ones Home Assistant runs by itself, the ones where Alma wakes up to look and decide,
// and the camera watches that are running right now.
import { Eye, Play, Trash2, Zap } from 'lucide-react'
import type { HomeScene } from '../../../shared/home'
import type { HomeRulesView } from '../../../shared/types'
import { request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'
import { control } from './homeLib'

interface Props {
  rules: HomeRulesView
  scenes: HomeScene[]
}

function Toggle({ on, label, onChange }: { on: boolean; label: string; onChange(on: boolean): void }): React.JSX.Element {
  return (
    <button role="switch" aria-checked={on} aria-label={label} className={`home-switch${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  )
}

export function RulesPanel({ rules, scenes }: Props): React.JSX.Element {
  const del = (kind: 'ha' | 'judgment' | 'watch', id: string, name: string): void => {
    if (confirm(`¿Borrar «${name}»?`)) void request({ method: 'home.rule.delete', kind, id })
  }
  return (
    <div className="home-rules">
      <section className="card">
        <h3>
          <Icon icon={Play} size={16} /> Modos
        </h3>
        {scenes.length === 0 ? (
          <p className="muted small">Todavía no hay modos. Pedile a Alma: «armame un modo Noche que apague todo menos el pasillo al 10 %».</p>
        ) : (
          <div className="row">
            {scenes.map((scene) => (
              <button key={scene.entityId} onClick={() => void control(scene.entityId, 'scene/turn_on')}>
                {scene.name}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h3>
          <Icon icon={Zap} size={16} /> Reglas automáticas
        </h3>
        <p className="muted small">Las corre Home Assistant solo: horarios, «si hay movimiento prendé la luz». No gastan nada de IA.</p>
        {rules.automations.length === 0 && <p className="muted small">No hay reglas. Pedile a Alma: «todos los días a las 23 apagá las luces».</p>}
        {rules.automations.map((rule) => (
          <div key={rule.id} className="home-rule">
            <Toggle on={rule.enabled} label={`Activar ${rule.name}`} onChange={(enabled) => void request({ method: 'home.rule.toggle', kind: 'ha', id: rule.id, enabled })} />
            <div className="grow">
              <b>{rule.name}</b>
              <div className="muted small">{rule.lastTriggered ? `Última vez: ${new Date(rule.lastTriggered).toLocaleString('es')}` : 'Todavía no se disparó'}</div>
            </div>
            <button className="icon-button" title="Borrar" onClick={() => del('ha', rule.id, rule.name)}>
              <Icon icon={Trash2} size="sm" />
            </button>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>
          <Icon icon={Eye} size={16} /> Reglas con criterio de Alma
        </h3>
        <p className="muted small">Cuando algo pasa, Alma se despierta, mira (cámaras incluidas) y decide qué hacer. Gastan IA solo cuando se disparan.</p>
        {rules.judgment.length === 0 && <p className="muted small">No hay reglas. Pedile a Alma: «si la cámara del patio detecta movimiento de noche, mirá y avisame solo si es una persona».</p>}
        {rules.judgment.map((rule) => (
          <div key={rule.id} className="home-rule">
            <Toggle on={rule.enabled} label={`Activar ${rule.name}`} onChange={(enabled) => void request({ method: 'home.rule.toggle', kind: 'judgment', id: rule.id, enabled })} />
            <div className="grow">
              <b>{rule.name}</b>
              <div className="muted small">
                {rule.entityId}
                {rule.to ? ` → ${rule.to}` : ''}
                {rule.between ? ` · de ${rule.between[0]} a ${rule.between[1]}` : ''} · espera {rule.cooldownMin} min · {rule.createdBy === 'agent' ? 'la creó Alma' : 'la creaste vos'}
              </div>
              <div className="small">{rule.prompt}</div>
            </div>
            <button className="icon-button" title="Borrar" onClick={() => del('judgment', rule.id, rule.name)}>
              <Icon icon={Trash2} size="sm" />
            </button>
          </div>
        ))}
      </section>

      {rules.watches.length > 0 && (
        <section className="card">
          <h3>
            <Icon icon={Eye} size={16} /> Vigilancias en curso
          </h3>
          {rules.watches.map((watch) => (
            <div key={watch.id} className="home-rule">
              <div className="grow">
                <b>{watch.cameraName}</b> — {watch.condition}
                <div className="muted small">
                  cada {watch.everySec} s · {watch.checks} miradas · hasta las {new Date(watch.until).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}
                  {watch.lastNote ? ` · última: ${watch.lastNote}` : ''}
                </div>
              </div>
              <button className="ghost small" onClick={() => void request({ method: 'home.rule.delete', kind: 'watch', id: watch.id })}>
                Detener
              </button>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
