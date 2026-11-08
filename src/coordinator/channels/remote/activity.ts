import { readAuditEntries } from '../../../shared/audit'
import type { ActivityEntry } from '../../../shared/types'

export type { ActivityEntry }

/** The recent-remote-entries view is capped at 50 (T27 choice: a tab-sized list). */
export const ACTIVITY_LIMIT = 50

/**
 * The remote-activity list (T27): remote-domain trail entries only (`remote.*` actions,
 * whatever the actor: revokes and sweeps are user/system), newest first.
 * The tab renders these (T38); pairing requests name no device yet, so they show empty.
 */
export function readRemoteActivity(input: { dataDir: string; devices: { id: string; name: string }[] }): ActivityEntry[] {
  const entries = readAuditEntries(input.dataDir, (entry) => entry.action.startsWith('remote.'))
  return entries
    .reverse()
    .slice(0, ACTIVITY_LIMIT)
    .map((entry) => {
      const deviceId = entry.detail?.deviceId
      return {
        ts: entry.ts,
        device: typeof deviceId === 'string' ? (input.devices.find((known) => known.id === deviceId)?.name ?? deviceId) : '',
        action: entry.action,
        outcome: entry.outcome
      }
    })
}
