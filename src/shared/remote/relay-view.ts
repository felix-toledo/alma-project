// What the Remote access tab shows about the relay (spec 027 T30): pure, so the rules are tested and the tab only renders.
import type { RelayFailure, RemoteSettings, RemoteStatus } from '../types'

export interface RelayTab {
  /** This build offers a relay at all (a packaged app whose relay domain is still the placeholder does not). */
  offered: boolean
  /** The relay is the selected connection and is offered. */
  viaRelay: boolean
  /** The Tailscale wizard shows: it is the other connection, and with the relay selected Tailscale is left alone. */
  tailscaleSteps: boolean
  /** The relay's own cause under its state, or null. */
  failure: RelayFailure | null
  /** The relay address changed since phones paired through it: the banner and its revoke offer. */
  renamed: boolean
  /** The relay check can run: the relay is selected and remote access is on. */
  canTest: boolean
  /** A phone can be paired now: the relay is selected, on and online. */
  canPair: boolean
  /** The device list says phones paired on the other connection stay listed but cannot connect. */
  devicesNote: boolean
}

export function relayTab(remote: RemoteSettings, status: RemoteStatus): RelayTab {
  const offered = status.relayHidden !== true
  const viaRelay = offered && remote.transport === 'relay'
  return {
    offered,
    viaRelay,
    tailscaleSteps: !viaRelay,
    failure: viaRelay && remote.enabled && status.state === 'error' ? (status.relayFailure ?? null) : null,
    renamed: viaRelay && status.relayRenamed === true,
    canTest: viaRelay && remote.enabled,
    canPair: viaRelay && remote.enabled && status.state === 'online',
    devicesNote: offered
  }
}
