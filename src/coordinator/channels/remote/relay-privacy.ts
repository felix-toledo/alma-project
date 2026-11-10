// What the person's own rights over their data say about the relay (spec 027 AC-8.2, AC-8.3).
import type { RemoteSettings } from '../../../shared/types'
import type { RelayStore } from './relay-store'

export interface TransportExport {
  transport: 'tailscale' | 'relay'
  relayOn: boolean
}

/** The two facts the export shows: which transport is selected and whether the relay is in use now. Nothing else leaves, so no credential can. */
export function transportExport(remote: RemoteSettings): TransportExport {
  return { transport: remote.transport, relayOn: remote.enabled && remote.transport === 'relay' }
}

/**
 * Erase: the PC leaves the relay, then its routing id and sealed credentials are deleted. The relay keeps nothing about
 * the PC, so it is told nothing: leaving is closing a socket here, not a message there.
 */
export async function eraseRelay(deps: { store: RelayStore; disconnect(): Promise<void> | void }): Promise<void> {
  try {
    await deps.disconnect()
  } catch {
    // A socket that is already gone is what erase wants.
  }
  await deps.store.erase()
}
