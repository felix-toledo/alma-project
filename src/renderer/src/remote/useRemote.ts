// The window's live copy of remote access: channel status, pairing, devices, activity.
import { useCallback, useEffect, useState } from 'react'
import type { ActivityEntry, DeviceView, PairingView, RemoteDetect, RemoteStatus, WizardTailscale } from '../../../shared/types'
import { onConnected, onEvent, request } from '../lib/coordinator'

export interface RemoteState {
  status: RemoteStatus
  pairing: PairingView | null
  devices: DeviceView[]
  tested: { deviceId: string; ok: boolean } | null
  activity: ActivityEntry[]
  /** Null until `remote.detect` answers (T30 wires it); the wizard waits for it. */
  tailscale: WizardTailscale | null
}

const EMPTY: RemoteState = { status: { state: 'off' }, pairing: null, devices: [], tested: null, activity: [], tailscale: null }

export function useRemote(enabled: boolean): RemoteState & { reload(): void; detect(): void } {
  const [state, setState] = useState<RemoteState>(EMPTY)

  const reload = useCallback(() => {
    if (!enabled) return
    void Promise.all([
      request<RemoteStatus>({ method: 'remote.status' }),
      request<DeviceView[]>({ method: 'remote.devices' }),
      request<ActivityEntry[]>({ method: 'remote.activity' })
    ])
      .then(([status, devices, activity]) => setState((s) => ({ ...s, status, devices, activity })))
      .catch(() => undefined)
  }, [enabled])

  const detect = useCallback(() => {
    if (!enabled) return
    // `remote.detect` is T30's; until it lands the answer is undefined and the
    // Tailscale wizard steps stay hidden (the off switch, pairing and devices work meanwhile).
    void request<RemoteDetect | undefined>({ method: 'remote.detect' })
      .then((found) => {
        if (found) setState((s) => ({ ...s, tailscale: found.tailscale, status: found.status }))
      })
      .catch(() => undefined)
  }, [enabled])

  useEffect(() => {
    if (!enabled) return setState(EMPTY)
    reload()
    detect()
    const offConnected = onConnected(() => {
      reload()
      detect()
    })
    const off = onEvent((event) => {
      if (event.type === 'remote.status') setState((s) => ({ ...s, status: event.status }))
      else if (event.type === 'remote.pairing') setState((s) => ({ ...s, pairing: event.pairing }))
      else if (event.type === 'remote.devices') setState((s) => ({ ...s, devices: event.devices }))
      else if (event.type === 'remote.tested') setState((s) => ({ ...s, tested: { deviceId: event.deviceId, ok: event.ok } }))
    })
    return () => {
      off()
      offConnected()
    }
  }, [enabled, reload, detect])

  return { ...state, reload, detect }
}
