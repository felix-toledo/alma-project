// Camera stills from the phone (T44): one picture at a time, refreshed by hand, no video.
import { Camera, RefreshCw } from 'lucide-react'
import { useCallback, useState } from 'react'
import { translatePwa, type PwaKey, type PwaLanguage } from '../i18n'
import type { PwaCamera } from '../lib/cameras'
import { camerasEvent, type HouseView } from '../lib/house-view'
import type { Pwa } from '../usePwa'
import { PwaHeader } from './Header'
import { StateMessage, StateView } from './StateView'
import { useLoad } from './useLoad'

type Note = { key: PwaKey } | { text: string }

export function Cameras({ pwa, language }: { pwa: Pwa; language: PwaLanguage }): React.JSX.Element {
  const t = (key: PwaKey): string => translatePwa(language, key)
  const [photo, setPhoto] = useState<{ src: string; entityId: string; name: string } | null>(null)
  const [note, setNote] = useState<Note | null>(null)
  const [loading, setLoading] = useState<string | null>(null)

  // The list is asked once per visit, never at each poll: `useLoad` reads `pwa` through a ref.
  const { state, reload } = useLoad<HouseView<PwaCamera[]>>(async () => camerasEvent(await pwa.cameras()), 'cameras')

  const load = useCallback(
    async (camera: Pick<PwaCamera, 'entityId' | 'name'>) => {
      setLoading(camera.entityId)
      try {
        const still = await pwa.still(camera.entityId)
        if (still.ok) {
          setNote(null)
          setPhoto({ src: `data:${still.mediaType};base64,${still.photo}`, entityId: camera.entityId, name: camera.name })
          return
        }
        if (still.reason === 'photo-too-big') setNote({ key: 'remote.pwa.photoTooBig' })
        else if (still.reason === 'camera-off') setNote({ key: 'remote.pwa.cameraOff' })
        else if (still.reason === 'scope-off') setNote({ key: 'remote.pwa.scopeOff' })
        else if (still.reason === 'rate-limited') setNote({ key: 'remote.pwa.rateLimited' })
        else if (still.reason === 'network') setNote({ key: 'remote.pwa.pcUnreachable' })
        else if (still.reason === 'denied' && still.note) setNote({ text: still.note })
      } finally {
        setLoading(null)
      }
    },
    [pwa]
  )

  return (
    <main className="pwa">
      <PwaHeader language={language} title={t('remote.pwa.tab.cameras')} />
      <StateView state={state} language={language} empty="remote.pwa.cameras.empty" onRetry={reload}>
        {(view) =>
          view.kind === 'off' ? (
            <StateMessage icon={Camera} text={view.note ?? t('remote.pwa.scopeOff')} />
          ) : (
            <ul className="pwa-list">
              {view.data.map((camera) => (
                <li key={camera.entityId}>
                  <button type="button" disabled={loading !== null} aria-busy={loading === camera.entityId || undefined} onClick={() => void load(camera)}>
                    <Camera className="pwa-list-icon" size={20} strokeWidth={1.75} aria-hidden="true" />
                    <span className="pwa-list-text">
                      <span className="pwa-list-name">{camera.name}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        }
      </StateView>
      <div role="status">{note && <p className="pwa-note">{'key' in note ? t(note.key) : note.text}</p>}</div>
      {loading !== null && <span className="pwa-spinner" aria-hidden="true" />}
      {photo && (
        <figure className="pwa-figure">
          <img className="pwa-photo" src={photo.src} alt="" />
          <figcaption className="pwa-muted">{photo.name}</figcaption>
          <button type="button" className="primary" disabled={loading !== null} onClick={() => void load(photo)}>
            <RefreshCw size={20} strokeWidth={1.75} aria-hidden="true" />
            {t('remote.pwa.refresh')}
          </button>
        </figure>
      )}
    </main>
  )
}
