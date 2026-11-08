import { formatDateTime } from '../i18n/format'
import type { Language } from '../i18n/language'
import type { MessageKey } from '../i18n/messages'
import type { DeviceView, RemoteFailure, RemoteStatus, WizardTailscale } from '../types'

export type { WizardTailscale }

/**
 * PC tab logic (T36): pure functions only. The renderer calls these; the PWA has
 * its own copy needs and does not use this file.
 */

/** The wizard step the tab shows (AC-2.7): each step names its blocker. */
export type WizardStep = 'download' | 'tailscale' | 'https' | 'serve' | 'test' | 'pair' | 'ready'

export function wizardStep(input: { tailscale: WizardTailscale; status: RemoteStatus; devices: number }): WizardStep {
  if (input.tailscale.state === 'missing') return 'download'
  if (input.tailscale.state === 'disconnected') return 'tailscale'
  if (!input.tailscale.https) return 'https'
  if (!input.tailscale.serving) return 'serve'
  if (input.status.state !== 'online') return 'test'
  return input.devices === 0 ? 'pair' : 'ready'
}

const FAILURE_KEYS: Record<RemoteFailure, MessageKey> = {
  noInternet: 'remote.wizard.fail.noInternet',
  tailscaleDown: 'remote.wizard.fail.tailscaleDown',
  httpsOff: 'remote.wizard.fail.httpsOff',
  listener: 'remote.wizard.fail.listener',
  phoneSilent: 'remote.wizard.fail.phoneSilent',
  portTaken: 'remote.wizard.fail.portTaken',
  serveBusy: 'remote.wizard.fail.serveBusy'
}

/** The cause text key for one connection-test failure (AC-2.4). */
export function failureKey(failure: RemoteFailure): MessageKey {
  return FAILURE_KEYS[failure]
}

/** Remote off marks every device dormant (AC-6.4); on leaves the list untouched. */
export function dormantMarking(devices: DeviceView[], remoteEnabled: boolean): DeviceView[] {
  if (remoteEnabled) return devices
  return devices.map((device) => ({ ...device, dormant: true }))
}

export interface ActivityRowText {
  when: string
  who: string | null
}

/** One activity row (AC-7.6): the date through the shared formatter, the resolved name as is. */
export function activityRowText(row: { ts: string; device: string }, language: Language): ActivityRowText {
  return { when: formatDateTime(language, new Date(row.ts), 'short'), who: row.device || null }
}
