import { Check, Loader2, Mic, Square, Volume2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { PublicSettings, VoiceStatus } from '../../../shared/types'
import { useT } from '../i18n/useT'
import { onEvent, request } from '../lib/coordinator'
import { Icon } from '../umbra/Icon'
import { chime, Player, startCapture, type Capture } from './audio'

type Labelled = 'recording' | 'transcribing' | 'thinking' | 'speaking' | 'loading'
const LABELLED = new Set<VoiceStatus['state']>(['recording', 'transcribing', 'thinking', 'speaking', 'loading'])
const isLabelled = (state: VoiceStatus['state']): state is Labelled => LABELLED.has(state)

/**
 * Keeps the microphone streaming to the coordinator while voice is on, plays what Alma says and shows a small
 * overlay during a request. Mounted once for the whole app (the window stays alive in the tray).
 */
export function VoiceLayer({ settings, status }: { settings: PublicSettings; status: VoiceStatus }): React.JSX.Element | null {
  const t = useT()
  const { enabled, micDeviceId } = settings.voice
  const [micError, setMicError] = useState('')
  const player = useRef<Player | null>(null)
  player.current ??= new Player(() => void request({ method: 'voice.played' }))

  useEffect(() => {
    if (!enabled) return
    let capture: Capture | null = null
    let cancelled = false
    setMicError('')
    startCapture(micDeviceId, (pcm) => window.desktop.coordinator.sendAudio(pcm))
      .then((c) => (cancelled ? c.stop() : (capture = c)))
      .catch((error: Error) => setMicError(error.name === 'NotAllowedError' ? t('voice.micDenied') : error.message))
    return () => {
      cancelled = true
      capture?.stop()
    }
  }, [enabled, micDeviceId])

  useEffect(
    () =>
      onEvent((event) => {
        if (event.type === 'voice.play') player.current!.enqueue(event.playback, event.last)
        else if (event.type === 'voice.stop') player.current!.stop()
      }),
    []
  )

  const previous = useRef(status.state)
  useEffect(() => {
    if (status.state === 'recording' && previous.current !== 'recording' && !status.followUp) chime()
    previous.current = status.state
  }, [status.state, status.followUp])

  const busy = status.state === 'recording' || status.state === 'transcribing' || status.state === 'thinking' || status.state === 'speaking'
  // Escape drops the turn (a false activation, a wrong transcript) before it costs anything.
  useEffect(() => {
    if (!enabled || !busy) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void request({ method: 'voice.cancel' })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, busy])

  if (!enabled) return null
  const label = isLabelled(status.state) ? t(`voice.state.${status.state}`) : undefined
  if (micError) return <div className="voice-overlay error">{micError}</div>
  if (!label) return null
  return (
    <div className={`voice-overlay state-${status.state}`} role="status" aria-live="polite">
      <span className="voice-orb">
        <Icon icon={status.state === 'speaking' ? Volume2 : status.state === 'recording' ? Mic : Loader2} size="sm" />
      </span>
      <div className="voice-text">
        <strong>{label}</strong>
        {status.transcript && <div className="small">«{status.transcript}»</div>}
        {status.state === 'speaking' && status.answer && <div className="small muted voice-answer">{status.answer}</div>}
        {status.detail && <div className="small muted">{status.detail}</div>}
      </div>
      {(status.state === 'speaking' || status.state === 'recording') && (
        <button className="icon-button" title={status.state === 'speaking' ? t('sidebar.voice.speaking') : t('voice.done')} onClick={() => void request({ method: 'voice.trigger' })}>
          <Icon icon={status.state === 'speaking' ? Square : Check} size="sm" />
        </button>
      )}
      <button className="icon-button" title={t('voice.cancelTitle')} onClick={() => void request({ method: 'voice.cancel' })}>
        <Icon icon={X} size="sm" />
      </button>
    </div>
  )
}
