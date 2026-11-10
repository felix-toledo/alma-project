// The app shell gate (spec 027 PD-13): which shell is running, and whether the PC announced it. A detection aid for the
// relay: the origin can still replace the service worker itself, so this makes a wrong or stale shell visible, no more.
import { acceptShell, readShellManifest, type ShellDecision, type ShellInfo } from '../../shared/remote/relay-shell'
import type { FetchLike } from '../lib/session'
import type { PwaStorage } from '../lib/storage'
import type { RelayClient } from './client'

export interface ShellCheck {
  /** The root hash of the shell that is running, as the origin serves it; null when it serves none. */
  hash: string | null
  /** Null when nothing was asked: a direct address, or a PC that could not be reached. */
  decision: ShellDecision | null
}

/** The shell-manifest.json the build wrote next to the app, read from the origin the page came from. */
export async function loadInstalledShell(rawFetch: FetchLike): Promise<ShellInfo | null> {
  try {
    const response = await rawFetch('/shell-manifest.json')
    return response.ok ? readShellManifest(await response.json()) : null
  } catch {
    return null
  }
}

/**
 * Over the relay, asks the PC for its signed announcement and applies `acceptShell`. A development build has no
 * manifest and so announces nothing: for the relay that reads as a shell nobody announced. A PC that cannot be asked is
 * not a refusal. Over a direct address (Tailscale) nothing is asked and nothing is refused.
 */
export async function checkShell(deps: { rawFetch: FetchLike; storage: PwaStorage; client: RelayClient | null }): Promise<ShellCheck> {
  const installed = await loadInstalledShell(deps.rawFetch)
  const hash = installed?.rootHash ?? null
  if (!deps.client) return { hash, decision: null }
  const announcement = await deps.client.announcement()
  if (announcement === 'unavailable') return { hash, decision: null }
  const pcKey = await deps.storage.loadPcKey()
  if (!pcKey) return { hash, decision: null }
  return { hash, decision: await acceptShell(installed ?? { version: 0, rootHash: '' }, announcement, pcKey) }
}
