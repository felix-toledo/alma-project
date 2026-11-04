import type { LucideIcon } from 'lucide-react'
import { Music, Volume1, Volume2, VolumeX, Waves } from 'lucide-react'
import { useT } from '../i18n/useT'
import { Icon } from './Icon'
import { useUISound } from './useUISound'

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

/** Settings tab: sounds, music, moving background and volume. */
export function AmbienceSettings(): React.JSX.Element {
  const t = useT()
  const s = useUISound()
  const pct = Math.round(s.volume * 100)
  return (
    <>
      <div className="card">
        <h3>{t('ambience.sound.title')}</h3>
        <Switch icon={s.muted ? VolumeX : Volume2} label={t('ambience.ui.label')} hint={t('ambience.ui.hint')} on={!s.muted} onToggle={() => s.setMuted(!s.muted)} />
        <Switch icon={Music} label={t('ambience.music.label')} hint={t('ambience.music.hint')} on={s.music} onToggle={() => s.setMusic(!s.music)} />
        <div className="setting-row">
          <Icon icon={pct === 0 ? VolumeX : pct < 50 ? Volume1 : Volume2} size="sm" className="setting-icon" />
          <div className="grow">
            <div>{t('ambience.volume.label')}</div>
            <div className="muted small">{t('ambience.volume.hint')}</div>
          </div>
          <label className="ambience-volume">
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={pct}
              aria-label={t('ambience.volume.aria')}
              data-consumes-lr
              onChange={(e) => s.setVolume(Number(e.target.value) / 100)}
              style={{ ['--pct' as string]: `${pct}%` }}
            />
            <span className="ambience-volume-value">{pct}%</span>
          </label>
        </div>
      </div>
      <div className="card">
        <h3>{t('ambience.appearance.title')}</h3>
        <Switch icon={Waves} label={t('ambience.motion.label')} hint={t('ambience.motion.hint')} on={s.motion} onToggle={() => s.setMotion(!s.motion)} />
      </div>
    </>
  )
}
