import type { LucideIcon } from 'lucide-react'
import { Music, Volume1, Volume2, VolumeX, Waves } from 'lucide-react'
import { Icon } from '../icons/Icon'
import { useUISound } from '../sound/useUISound'

function Switch({ icon, label, hint, on, onToggle }: { icon: LucideIcon; label: string; hint: string; on: boolean; onToggle(): void }): React.JSX.Element {
  return (
    <div className="setting-row">
      <Icon icon={icon} size="sm" className="setting-icon" />
      <div className="grow">
        <div>{label}</div>
        <div className="muted small">{hint}</div>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={label} className="switch" onClick={onToggle}>
        <span className="switch-knob" />
      </button>
    </div>
  )
}

/** Pestaña de Configuración: sonidos, música, fondo en movimiento y volumen. */
export function AmbienceSettings(): React.JSX.Element {
  const s = useUISound()
  const pct = Math.round(s.volume * 100)
  return (
    <>
      <div className="card">
        <h3>Sonido</h3>
        <Switch icon={s.muted ? VolumeX : Volume2} label="Sonidos de interfaz" hint="Un tono suave al pasar y al elegir." on={!s.muted} onToggle={() => s.setMuted(!s.muted)} />
        <Switch icon={Music} label="Música de fondo" hint="Ambiente tranquilo mientras la app está visible." on={s.music} onToggle={() => s.setMusic(!s.music)} />
        <div className="setting-row">
          <Icon icon={pct === 0 ? VolumeX : pct < 50 ? Volume1 : Volume2} size="sm" className="setting-icon" />
          <div className="grow">
            <div>Volumen</div>
            <div className="muted small">Música y sonidos de interfaz.</div>
          </div>
          <label className="ambience-volume">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={pct}
              aria-label="Volumen de música y sonidos"
              data-consumes-lr
              onChange={(e) => s.setVolume(Number(e.target.value) / 100)}
              style={{ ['--pct' as string]: `${pct}%` }}
            />
            <span className="ambience-volume-value">{pct}%</span>
          </label>
        </div>
      </div>
      <div className="card">
        <h3>Apariencia</h3>
        <Switch icon={Waves} label="Fondo en movimiento" hint="Luz y partículas que flotan despacio. Apagado, el fondo queda quieto." on={s.motion} onToggle={() => s.setMotion(!s.motion)} />
      </div>
    </>
  )
}
