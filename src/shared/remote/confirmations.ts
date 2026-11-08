import type { RemoteScope, RemoteSettings } from '../types'
import { canonicalVaultPath } from '../vault/paths'
import { defaultRemote } from './settings'

export type RemoteConfirmation =
  | { kind: 'enable'; dormant: string[] }
  | { kind: 'scope'; scope: RemoteScope; vaultFolder?: string }
  | { kind: 'sensitive' }
  | { kind: 'continue' }
  | { kind: 'unexclude'; folder: string }
  | { kind: 'camera'; cameraId: string }
  | { kind: 'pair'; name: string; code: string }
  | { kind: 'serve'; command: string }
  | { kind: 'revokeAll' }
  | { kind: 'download'; url: string }

const SCOPE_ORDER: readonly RemoteScope[] = ['chat', 'approve', 'home', 'cameras', 'vault', 'history']

/**
 * Which native confirmations a settings change needs, and the section to save when they all pass.
 * Widening asks (turn on, scope on, locks on, continue on, camera added, exclusion removed); narrowing never does.
 * Order is fixed: enable, scopes, locks, continue, cameras in list order, then removed exclusions in list order.
 */
export function planRemoteChange(
  before: RemoteSettings,
  after: RemoteSettings,
  dormantNames: string[],
  context: { activeVault: string }
): { confirmations: RemoteConfirmation[]; next: RemoteSettings } {
  const confirmations: RemoteConfirmation[] = []
  let next = after
  if (!before.enabled && after.enabled) {
    confirmations.push({ kind: 'enable', dormant: [...dormantNames] })
    next = { ...after, scopes: defaultRemote().scopes, sensitive: false, continueHistory: false }
  } else if (before.enabled && after.enabled) {
    // Without History there is nothing to continue, so the sub-switch cannot outlive it.
    next = { ...after, continueHistory: after.continueHistory && after.scopes.history }
    for (const scope of SCOPE_ORDER) {
      if (before.scopes[scope] || !after.scopes[scope]) continue
      confirmations.push(scope === 'vault' ? { kind: 'scope', scope, vaultFolder: context.activeVault } : { kind: 'scope', scope })
    }
    if (!before.sensitive && after.sensitive) confirmations.push({ kind: 'sensitive' })
    if (!before.continueHistory && next.continueHistory) confirmations.push({ kind: 'continue' })
  }
  // The camera and exclusion lists persist across turn-ons, so what widens them asks even while remote is off.
  return { confirmations: [...confirmations, ...cameraConfirmations(before.cameras, after.cameras), ...unexcludeConfirmations(before.vaultExcluded, after.vaultExcluded)], next }
}

function cameraConfirmations(before: readonly string[], after: readonly string[]): RemoteConfirmation[] {
  const known = new Set(before)
  return after.filter((id) => !known.has(id)).map((cameraId) => ({ kind: 'camera', cameraId }))
}

function unexcludeConfirmations(before: readonly string[], after: readonly string[]): RemoteConfirmation[] {
  const kept = new Set(after.map(canonicalVaultPath))
  return before.filter((folder) => !kept.has(canonicalVaultPath(folder))).map((folder) => ({ kind: 'unexclude', folder }))
}

/** Asks each confirmation in turn; the first refusal ends it with nothing asked after. */
export function runConfirmations(list: readonly RemoteConfirmation[], ask: (c: RemoteConfirmation) => boolean): 'ok' | 'denied' {
  for (const confirmation of list) if (!ask(confirmation)) return 'denied'
  return 'ok'
}

/** The coordinator must never change remote access (BR-11): its patches arrive without the section. */
export function stripRemotePatch<T extends object>(patch: T): Omit<T, 'remote'> {
  const copy = { ...patch } as Record<string, unknown>
  delete copy.remote
  return copy as Omit<T, 'remote'>
}
