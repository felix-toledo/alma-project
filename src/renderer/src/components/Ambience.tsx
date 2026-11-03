import { useSyncExternalStore } from 'react'
import { getPrefs, setPrefs, subscribe } from '../lib/ambience'
import { Moon, Music, Sun, Volume2, VolumeX, Waves } from 'lucide-react'
import { Icon } from '../umbra/Icon'

// One seamless period is 1440 wide; the path holds two so sliding it by half loops without a seam.
const WAVE = 'M0 160 Q 360 70 720 160 T 1440 160 T 2160 160 T 2880 160 V 320 H 0 Z'
const WAVE_LINE = 'M0 170 Q 360 110 720 170 T 1440 170 T 2160 170 T 2880 170'

/** Slow-moving console-style background behind the whole app. */
export function Backdrop(): React.JSX.Element {
  return (
    <div className="backdrop" aria-hidden>
      <div className="backdrop-glow one" />
      <div className="backdrop-glow two" />
      <div className="backdrop-glow three" />
      <svg className="backdrop-wave slow" viewBox="0 0 2880 320" preserveAspectRatio="none">
        <path d={WAVE} />
      </svg>
      <svg className="backdrop-wave fast" viewBox="0 0 2880 320" preserveAspectRatio="none">
        <path d={WAVE_LINE} />
      </svg>
      <div className="backdrop-particles" />
    </div>
  )
}

/** Quick toggles: theme, background motion, UI sounds and music. */
export function AmbienceControls(): React.JSX.Element {
  const prefs = useSyncExternalStore(subscribe, getPrefs)
  const toggles = [
    {
      on: prefs.theme === 'dark',
      icon: prefs.theme === 'dark' ? Moon : Sun,
      title: prefs.theme === 'dark' ? 'Tema oscuro (cambiar a claro)' : 'Tema claro (cambiar a oscuro)',
      toggle: () => setPrefs({ theme: prefs.theme === 'dark' ? 'light' : 'dark' }),
      alwaysLit: true
    },
    { on: prefs.motion, icon: Waves, title: 'Fondo en movimiento', toggle: () => setPrefs({ motion: !prefs.motion }) },
    { on: prefs.sounds, icon: prefs.sounds ? Volume2 : VolumeX, title: 'Sonidos de interfaz', toggle: () => setPrefs({ sounds: !prefs.sounds }) },
    { on: prefs.music, icon: Music, title: 'Música de fondo', toggle: () => setPrefs({ music: !prefs.music }) }
  ]
  return (
    <div className="ambience-controls" role="group" aria-label="Ambiente">
      {toggles.map((t) => (
        <button
          key={t.title}
          className={`ambience-toggle${t.on || t.alwaysLit ? ' on' : ''}`}
          aria-pressed={t.alwaysLit ? undefined : t.on}
          title={t.title}
          onClick={t.toggle}
        >
          <Icon icon={t.icon} size="sm" />
        </button>
      ))}
    </div>
  )
}
