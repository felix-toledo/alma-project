// The one remote-access change that skips the native dialog: a folder renamed or moved in Alma's own vault view
// carries its exclusion along (spec 028 AC-1.11, Q6). Pure on purpose (no electron), so it is tested.
import { z } from 'zod'
import { canonicalVaultPath, moveExclusions } from '../shared/vault/paths'
import type { RemoteSettings } from '../shared/types'

export const MoveExclusionsArgs = z.object({ from: z.string().max(1024), to: z.string().max(1024) }).strict()

/**
 * The new exclusion list after a move, or null when nothing changes (bad args, no entry at or under `from`, or the
 * vault did not really move: `to` must exist and `from` must not). A lying renderer cannot un-exclude a folder this way.
 */
export function movedExclusions(remote: RemoteSettings, args: unknown, exists: (path: string) => boolean): string[] | null {
  const parsed = MoveExclusionsArgs.safeParse(args)
  if (!parsed.success) return null
  const { from, to } = parsed.data
  // A case-only rename leaves the folder at both spellings on a case-insensitive disk.
  const sameFolder = canonicalVaultPath(from) === canonicalVaultPath(to)
  if (!exists(to) || (!sameFolder && exists(from))) return null
  const next = moveExclusions(remote.vaultExcluded, parsed.data.from, parsed.data.to)
  return next.every((entry, i) => entry === remote.vaultExcluded[i]) ? null : next
}
