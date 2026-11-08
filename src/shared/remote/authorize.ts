import type { RemoteSettings } from '../types'
import type { Refusal, RouteSpec } from './api'

export interface DeviceAuth {
  deviceId: string
}

/**
 * One verdict for one request, whatever carries it: the function takes no transport input (AC-3.2).
 * Order is fixed: device, scope, locks-and-alarms, continue sub-switch, camera allow-list.
 */
export function authorizeRemote(input: { device: DeviceAuth | null; remote: RemoteSettings; route: RouteSpec; cameraId?: string }): { ok: true } | { ok: false; reason: Refusal } {
  const { device, remote, route, cameraId } = input
  if (route.auth === 'session' && !device) return { ok: false, reason: 'unknown-device' }
  if (route.scope !== undefined) {
    const scopes = typeof route.scope === 'string' ? [route.scope] : route.scope
    if (!scopes.some((scope) => remote.scopes[scope])) return { ok: false, reason: 'scope-off' }
  }
  if (route.sensitive && !remote.sensitive) return { ok: false, reason: 'sensitive-off' }
  if (route.continue && !remote.continueHistory) return { ok: false, reason: 'write-off' }
  if (cameraId !== undefined && !remote.cameras.includes(cameraId)) return { ok: false, reason: 'camera-not-allowed' }
  return { ok: true }
}

export type SecureAction = 'lock' | 'unlock' | 'open' | 'close' | 'arm_home' | 'arm_away' | 'disarm' | 'trigger'

/** Only opening and disarming need a step-up; locking, closing, arming and the siren's trigger do not (AC-5.20). */
export function stepUpRequired(action: SecureAction): boolean {
  return action === 'unlock' || action === 'open' || action === 'disarm'
}
