// Spec 027 PD-11: the relay's runtime state is laid over the channel's status at the composition root, because the
// channel's own outage report is Tailscale-specific and the channel is not edited.
import type { MessageKey } from '../i18n/messages'
import type { RelayFailure, RemoteStatus } from '../types'

export type RelayState = { state: 'off' | 'connecting' | 'online' | 'error'; failure?: RelayFailure; detail?: string; renamed?: boolean }

const CAUSES: readonly string[] = ['relayUnreachable', 'relayRefused', 'relayFull', 'relayVersion', 'relayGone'] satisfies RelayFailure[]

/**
 * Null (Tailscale selected) returns the channel's status untouched. Otherwise the relay can only worsen a channel that is
 * up: an error needs one of the closed causes (a phone's failed handshake is never one), and the channel's own state
 * (off, or its own error) is never replaced.
 */
export function overlayRelayStatus(channel: RemoteStatus, relay: RelayState | null): RemoteStatus {
  if (!relay) return channel
  const renamed = relay.renamed ? { relayRenamed: true } : {}
  const up = channel.state === 'online' || channel.state === 'connecting'
  if (up && relay.state === 'error' && relay.failure && CAUSES.includes(relay.failure)) {
    const { failure: _own, detail: _detail, ...rest } = channel
    return { ...rest, state: 'error', relayFailure: relay.failure, ...(relay.detail === undefined ? {} : { detail: relay.detail }), ...renamed }
  }
  if (channel.state === 'online' && relay.state === 'connecting') return { ...channel, state: 'connecting', ...renamed }
  return relay.renamed ? { ...channel, ...renamed } : channel
}

const FAILURE_KEYS: Record<RelayFailure, MessageKey> = {
  relayUnreachable: 'remote.relay.fail.unreachable',
  relayRefused: 'remote.relay.fail.refused',
  relayFull: 'remote.relay.fail.full',
  relayVersion: 'remote.relay.fail.version',
  relayGone: 'remote.relay.fail.gone'
}

/** The cause text for one relay failure (spec 027 BR-30). `relayGone` points the person to Tailscale (AC-8.7). */
export function relayFailureKey(failure: RelayFailure): MessageKey {
  return FAILURE_KEYS[failure]
}

/** The words for the {reason} of a refusal: the detail the connection reports is the relay's close code. */
export function refusedReasonKey(detail: string | undefined): MessageKey {
  if (detail === '4001') return 'remote.relay.refused.registration'
  if (detail === '4002') return 'remote.relay.refused.replaced'
  if (detail === '4003') return 'remote.relay.refused.held'
  return 'remote.relay.refused.other'
}
