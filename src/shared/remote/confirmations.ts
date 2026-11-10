import type { ProviderId, RemoteScope, RemoteSettings } from '../types'
import { canonicalVaultPath } from '../vault/paths'
import { defaultRemote } from './settings'

export type RemoteConfirmation =
  // `relay` is set only while the relay is the selected transport, so the dialog can name it (spec 027 AC-1.13).
  | { kind: 'enable'; dormant: string[]; relay?: true }
  | { kind: 'relay' }
  | { kind: 'scope'; scope: RemoteScope; vaultFolder?: string }
  | { kind: 'sensitive' }
  | { kind: 'continue' }
  // The providers that would read a file sent from the phone, named in the dialog (spec 031 AC-1.4).
  | { kind: 'attachments'; providers: ProviderId[] }
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
 * Order is fixed: enable, the relay, scopes, locks, continue, send files, cameras in list order, then removed exclusions in list order.
 * Choosing the relay asks even while remote is off; choosing Tailscale again narrows and asks nothing (spec 027 AC-1.2).
 */
export function planRemoteChange(
  before: RemoteSettings,
  after: RemoteSettings,
  dormantNames: string[],
  // `attachReaders` is optional so a caller that only cares about the older confirmations needs no change; `main` always passes it.
  context: { activeVault: string; attachReaders?: ProviderId[] }
): { confirmations: RemoteConfirmation[]; next: RemoteSettings } {
  const confirmations: RemoteConfirmation[] = []
  let next = after
  if (!before.enabled && after.enabled) {
    confirmations.push(after.transport === 'relay' ? { kind: 'enable', dormant: [...dormantNames], relay: true } : { kind: 'enable', dormant: [...dormantNames] })
    next = { ...after, scopes: defaultRemote().scopes, sensitive: false, continueHistory: false, sendFiles: false }
  }
  if (before.transport !== 'relay' && after.transport === 'relay') confirmations.push({ kind: 'relay' })
  if (before.enabled && after.enabled) {
    // Without History there is nothing to continue, so the sub-switch cannot outlive it.
    // Sending files is part of Chat, so it cannot outlive it either (spec 031 AC-1.3).
    next = { ...after, continueHistory: after.continueHistory && after.scopes.history, sendFiles: after.sendFiles && after.scopes.chat }
    for (const scope of SCOPE_ORDER) {
      if (before.scopes[scope] || !after.scopes[scope]) continue
      confirmations.push(scope === 'vault' ? { kind: 'scope', scope, vaultFolder: context.activeVault } : { kind: 'scope', scope })
    }
    if (!before.sensitive && after.sensitive) confirmations.push({ kind: 'sensitive' })
    if (!before.continueHistory && next.continueHistory) confirmations.push({ kind: 'continue' })
    if (!before.sendFiles && next.sendFiles) {
      // Consent must name the providers; a caller that cannot name them never switches file sending on.
      if (context.attachReaders) confirmations.push({ kind: 'attachments', providers: [...context.attachReaders] })
      else next = { ...next, sendFiles: false }
    }
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
