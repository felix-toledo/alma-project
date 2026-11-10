// The shell gate (spec 027 PD-13): decides whether the app shell the phone is running is one the PC announced.
// A detection aid, not a wall: the origin can still replace the service worker itself (BR-26).
import { b64u, type PublicJwk, verifyEs256 } from './crypto'

export type ShellDecision = 'current' | 'update' | 'refuse'
export interface ShellInfo {
  version: number
  rootHash: string
}
export interface ShellAnnouncement extends ShellInfo {
  sig: string
}

/** What the PC signs: the NUL separators keep version and hash from sliding into each other. */
export function shellAnnouncementMessage(version: number, rootHash: string): Uint8Array {
  return new TextEncoder().encode(`alma-shell\0${version}\0${rootHash}`)
}

/**
 * `current`: the running hash is the one the PC announced. `update`: the PC announced a newer version with another hash.
 * `refuse`: nothing announced, a signature that is not this PC's, a downgrade, or the same version under another hash.
 */
export async function acceptShell(installed: ShellInfo, announcement: ShellAnnouncement | null, pcKey: PublicJwk): Promise<ShellDecision> {
  if (!announcement) return 'refuse'
  let signature: Uint8Array
  try {
    signature = b64u.decode(announcement.sig)
  } catch {
    return 'refuse'
  }
  if (!(await verifyEs256(pcKey, shellAnnouncementMessage(announcement.version, announcement.rootHash), signature))) return 'refuse'
  if (announcement.version < installed.version) return 'refuse'
  if (announcement.rootHash === installed.rootHash) return 'current'
  return announcement.version > installed.version ? 'update' : 'refuse'
}

/** The version and root hash out of a parsed shell-manifest.json (written by scripts/shell-manifest.mts), or null when it is not one. */
export function readShellManifest(value: unknown): ShellInfo | null {
  if (typeof value !== 'object' || value === null) return null
  const { version, rootHash } = value as { version?: unknown; rootHash?: unknown }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return null
  if (typeof rootHash !== 'string' || !/^[0-9a-f]{64}$/.test(rootHash)) return null
  return { version, rootHash }
}
